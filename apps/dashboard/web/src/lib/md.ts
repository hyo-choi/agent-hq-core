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
export const mdHtml = (text: string) => md.render(text);
// 카드 요약·알림용 plain text. 같은 parser의 inline 토큰에서 글자만 모아 `##`·`**`·표 구분선 같은 기호를 숨긴다(HTML 없음, 코드 블록 제외)
export const mdPlain = (text?: string | null) => text ? md.parse(text, {}).filter(t => t.type === 'inline')
  .map(t => t.children!.map(c => c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : c.type === 'text' || c.type === 'code_inline' ? c.content : '').join('')).join(' ') : '';
