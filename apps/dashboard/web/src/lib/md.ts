// 긴 본문(작업 결론·검증·남은 일, 질문 답변, 결정 내용·대기 범위, 메시지)용 Markdown → HTML.
// html:false라 raw HTML은 글자로 이스케이프된다(markdown-it docs/safety.md). 링크는 http·https 절대 URL만 남기고 새 탭으로 연다(진행판이 http tailnet으로 서빙되므로 http 허용).
// 이미지는 외부 콘텐츠를 불러오지 않도록 끈다. breaks:true는 기존 plain 기록의 한 줄 바꿈을 그대로 보이게 한다
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).disable('image');
// 라이브러리 기본 검사(javascript·vbscript·file·data 차단)를 먼저 통과해야 하고, 그 위에 http(s) 절대 URL만 남긴다.
// 상대 경로·mailto 등은 링크로 만들지 않는다. 다른 화면의 safeUrl(https 전용) 계약은 그대로다
const baseValidate = md.validateLink.bind(md);
md.validateLink = url => baseValidate(url) && /^https?:\/\/[^/?#\s]/i.test(url);
md.renderer.rules.link_open = (tokens, i, opts, _env, self) => {
  tokens[i].attrSet('target', '_blank');
  tokens[i].attrSet('rel', 'noopener noreferrer');
  tokens[i].attrJoin('class', 'link link-info');
  return self.renderToken(tokens, i, opts);
};
// 긴 글 셀만 최소 폭을 줘(.md-long) 좁은 화면에서 한 열이 세로로 길어지지 않게 한다. 폭은 CSS로 정하고 표는 자기 안에서 스크롤한다
md.renderer.rules.td_open = (tokens, i, opts, _env, self) => {
  if (tokens[i + 1].content.length > 40) tokens[i].attrJoin('class', 'md-long');
  return self.renderToken(tokens, i, opts);
};
// GFM은 헤더와 구분선의 열 수가 다르면 표로 보지 않아 파이프가 글자로 노출된다. 작성 실수의 의도가 분명하므로 구분선만 헤더 열 수에 맞춘다(본문 행의 넘침·부족은 parser가 처리)
const DELIM = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (row: string) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
const fixTableDelims = (src: string) => {
  let fence = '';
  return src.split('\n').map((line, i, lines) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (f && !fence) fence = f;
    else if (f && f[0] === fence[0] && f.length >= fence.length) fence = '';
    const head = lines[i - 1];
    if (fence || f || !head || !line.includes('|') || !DELIM.test(line) || /^ {4}/.test(head) || !/(?<!\\)\|/.test(head) || DELIM.test(head)) return line;
    const want = cellsOf(head).length, have = cellsOf(line);
    if (want === have.length) return line;
    return '| ' + Array.from({ length: want }, (_, k) => have[k] ?? '---').join(' | ') + ' |';
  }).join('\n');
};
md.core.ruler.after('normalize', 'fix_table_delims', state => { state.src = fixTableDelims(state.src); });
export const mdHtml = (text: string) => md.render(text);
// 카드 요약·알림용 plain text. 같은 parser의 inline 토큰에서 글자만 모아 `##`·`**`·표 구분선 같은 기호를 숨긴다(HTML 없음, 코드 블록 제외)
export const mdPlain = (text?: string | null) => text ? md.parse(text, {}).filter(t => t.type === 'inline')
  .map(t => t.children!.map(c => c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : c.type === 'text' || c.type === 'code_inline' ? c.content : '').join('')).join(' ') : '';

// 본문 전체를 한 번 파싱하므로 코드 블록의 ###와 중첩 제목을 오인하지 않고 참조 링크도 유지한다.
export const ACTION_HEADINGS = ['해 주실', '확인해 주실', '정해 주실', '필요한 결정', '추천', '선택지', '막힌 이유', '주의하실', '꼭 확인', '머지 전에', '위험', '알아 두실', '필요한 선택', '우선 결정', '다음 행동'] as const;
export function mdSections(text: string) {
  const env = {}, tokens = md.parse(text, env);
  const heading = (i: number) => tokens[i].type === 'heading_open' && tokens[i].level === 0;
  const starts = tokens.flatMap((t, i) => heading(i) && t.tag === 'h3' ? [i] : []);
  const html = (from: number, to: number) => md.renderer.render(tokens.slice(from, to), md.options, env);
  const plain = (i: number) => tokens[i + 1].children!.map(t => t.type === 'text' || t.type === 'code_inline' ? t.content : t.type.endsWith('break') ? ' ' : '').join('');
  const action = (title: string) => ACTION_HEADINGS.some(s => title.includes(s));
  const seen = new Map<string, number>();
  return {
    intro: html(0, starts[0] ?? tokens.length),
    sections: starts.map((start, i) => {
      const next = starts[i + 1] ?? tokens.length;
      let end = start + 3;
      while (end < next && !(heading(end) && /^h[123]$/.test(tokens[end].tag))) end++;
      const title = plain(start), occurrence = seen.get(title) || 0;
      // 같은 제목은 등장 순서로 구분한다. 앞에 같은 제목을 삽입하면 저장된 상태가 밀릴 수 있다.
      seen.set(title, occurrence + 1);
      const childAction = tokens.some((t, j) => j > start && j < end && heading(j) && action(plain(j)));
      return { title, titleHtml: md.renderer.renderInline(tokens[start + 1].children!, md.options, env), key: JSON.stringify([title, occurrence]),
        open: action(title) || childAction, html: html(start + 3, end), after: html(end, next) };
    }),
  };
}

// 안쪽에 표시하는 h3 섹션을 센다. 하위 행동 제목도 mdSections의 같은 판정에 따른다.
export const mdActionCount = (...texts: (string | null | undefined)[]) => texts.reduce((count, text) =>
  count + (text ? mdSections(text).sections.filter(s => s.open).length : 0), 0);
