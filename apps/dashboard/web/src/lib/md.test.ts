// Markdown 렌더 규칙: 지원 문법, raw HTML·위험 URL 차단, 이미지 미로드, 기존 plain 기록 호환
import { describe, expect, it } from 'vitest';
import { mdActionCount, mdHtml, mdPlain, mdSections } from './md';

const dom = (t: string) => { const d = document.createElement('div'); d.innerHTML = mdHtml(t); return d; };

describe('mdHtml', () => {
  it('제목·강조·목록·링크·코드·표를 그린다', () => {
    const d = dom('## 배경\n**굵게** *기울임* `x()`\n\n- 하나\n- 둘\n\n1. 첫째\n\n[문서](https://example.com/a)\n\n```\nconst a = 1;\n```\n\n| 선택지 | 영향 |\n| --- | --- |\n| A | 빠름 |');
    expect(d.querySelector('h2')!.textContent).toBe('배경');
    expect(d.querySelector('strong')!.textContent).toBe('굵게');
    expect(d.querySelector('em')).toBeTruthy();
    expect(d.querySelector('p > code')!.textContent).toBe('x()');
    expect(d.querySelectorAll('ul > li').length).toBe(2);
    expect(d.querySelector('ol > li')).toBeTruthy();
    const a = d.querySelector('a')!;
    expect([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]).toEqual(['https://example.com/a', '_blank', 'noopener noreferrer']);
    expect(d.querySelector('pre > code')!.textContent).toBe('const a = 1;\n');
    expect([...d.querySelectorAll('th')].map(x => x.textContent)).toEqual(['선택지', '영향']);
    expect(d.querySelector('p p, p pre, p table, p ul')).toBeNull();
  });
  it('raw HTML·script·handler는 글자로만 남고 javascript/data 링크와 이미지는 만들지 않는다', () => {
    const d = dom('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<b onclick="x()">b</b>\n\n[j](javascript:alert(1)) [d](data:text/html,<script>1</script>) [v](vbscript:x) [r](/api/messages)\n\n![이미지](https://example.com/a.png)\n\njavascript:alert(1)');
    expect(d.querySelector('script, img, b, [onerror], [onclick], iframe')).toBeNull();
    // 이미지 문법은 불러오지 않고 https 링크로만 남는다
    expect([...d.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://example.com/a.png']);
    expect(d.textContent).toContain('<script>alert(1)</script>');
    expect(d.textContent).toContain('[j](javascript:alert(1))');
  });
  it('http tailnet 링크와 https 링크는 그리고, 대소문자·공백·인코딩을 바꾼 위험 URL과 상대 경로는 링크로 만들지 않는다', () => {
    const d = dom('[운영](http://dash.example.ts.net:48173/#work) [s](https://example.com/b) http://100.64.0.1:48173/\n\n[a](JavaScript:alert(1)) [b](java\tscript:alert(1)) [c](%6Aavascript:alert(1)) [d](DATA:text/html;base64,PHNjcmlwdD4=) [e](data:image/png;base64,AAAA) [f](file:///etc/passwd) [g](vbscript:x) [h](//evil.example/x) [i](http:/x) [j](mailto:a@b.c)');
    expect([...d.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['http://dash.example.ts.net:48173/#work', 'https://example.com/b', 'http://100.64.0.1:48173/']);
    expect([...d.querySelectorAll('a')].every(a => a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
  });
  it('기존 plain 기록은 줄바꿈을 유지하고 https 맨 URL은 링크가 된다', () => {
    const d = dom('첫 줄\n둘째 줄 https://github.com/example/repo/pull/1234\n\n다음 문단');
    expect(d.querySelectorAll('p').length).toBe(2);
    expect(d.querySelector('p')!.querySelectorAll('br').length).toBe(1);
    expect(d.querySelector('a')!.getAttribute('href')).toBe('https://github.com/example/repo/pull/1234');
  });
  it('구분선 열 수가 헤더와 달라도 표로 그리고 셀 인라인 Markdown과 정렬을 유지한다', () => {
    const fewer = dom('| ID | 질문 | 상태 | 추천 | 영향 |\n| --- | :-: | --- | --- |\n| **D2** | `코드` | [PR](https://example.com/1) | *강조* | 끝 |');
    expect(fewer.querySelectorAll('th').length).toBe(5);
    expect(fewer.querySelectorAll('tbody td').length).toBe(5);
    expect(fewer.querySelectorAll('th')[1].getAttribute('style')).toContain('center');
    expect(fewer.querySelector('td strong')!.textContent).toBe('D2');
    expect(fewer.querySelector('td code')!.textContent).toBe('코드');
    expect(fewer.querySelector('td a')!.getAttribute('href')).toBe('https://example.com/1');
    expect(fewer.querySelector('td em')!.textContent).toBe('강조');
    expect(fewer.querySelector('p')).toBeNull();
    const more = dom('a | b\n--|--|--\n1 | 2');
    expect([...more.querySelectorAll('th')].map(x => x.textContent)).toEqual(['a', 'b']);
    expect(dom('| a\\|b | c |\n| --- |\n| 1 | 2 |').querySelectorAll('th').length).toBe(2);
    expect(mdPlain('| A | B |\n| --- |\n| 1 | 2 |')).toBe('A B 1 2');
  });
  it('긴 글 셀에만 최소 폭 class를 붙인다', () => {
    const d = dom(`| a | b |\n| --- | --- |\n| 짧음 | ${'긴 글 '.repeat(20)} |`);
    expect([...d.querySelectorAll('td')].map(x => x.classList.contains('md-long'))).toEqual([false, true]);
  });
  it('표가 아닌 구분선·코드 블록의 파이프는 바꾸지 않는다', () => {
    const fenced = '```\n| a | b |\n| --- |\n```';
    expect(dom(fenced).querySelector('table')).toBeNull();
    expect(dom(fenced).querySelector('pre')!.textContent).toBe('| a | b |\n| --- |\n');
    expect(dom('~~~~\n```\n| a | b |\n| --- |\n~~~~').querySelector('table')).toBeNull();
    expect(dom('제목\n---').querySelector('h2')!.textContent).toBe('제목');
    expect(dom('글자 a | b\n\n---').querySelector('hr')).toBeTruthy();
    expect(dom('    | a | b |\n    | --- |').querySelector('pre, table')!.tagName).toBe('PRE');
  });
  it('요약용 plain text는 Markdown 기호를 빼고 글자만 남긴다', () => {
    expect(mdPlain('#### 배경\n**추천** `A`\n\n| 선택지 | 영향 |\n| --- | --- |\n| A | 빠름 |\n\n```\ncode\n```')).toBe('배경 추천 A 선택지 영향 A 빠름');
    expect(mdPlain('plain 기록\n둘째 줄')).toBe('plain 기록 둘째 줄');
    expect(mdPlain(undefined)).toBe('');
  });
});

describe('Markdown 소제목 접기', () => {
  it('사용자 행동 표현만 기본으로 펼치고 소제목 앞 글을 보존한다', () => {
    const { intro, sections } = mdSections('앞 안내\n\n' + ['해 주실', '확인해 주실', '정해 주실', '필요한 결정', '추천', '선택지', '막힌 이유', '주의하실', '꼭 확인', '머지 전에', '위험', '알아 두실', '필요한 선택', '우선 결정', '다음 행동'].map(s => `### ${s} 내용\n본문`).join('\n\n') + '\n\n### 배경\n정보');
    expect(intro).toContain('<p>앞 안내</p>');
    expect(sections.map(s => s.open)).toEqual([...Array(15).fill(true), false]);
    expect(sections.at(-1)!.html).toContain('정보');
    expect(mdSections('소제목 없는 본문')).toEqual({ intro: mdHtml('소제목 없는 본문'), sections: [] });
  });
  it('코드 블록·들여쓰기·인용문 안의 제목은 나누지 않고 참조 링크를 보존한다', () => {
    const body = '```md\n### 코드 제목\n```\n\n~~~~\n### 다른 코드\n~~~~\n\n    ### 들여쓴 코드\n\n> ### 인용 제목\n\n### 배경\n[근거][ref]\n\n[ref]: https://example.com';
    const { intro, sections } = mdSections(body);
    expect(sections.map(s => s.title)).toEqual(['배경']);
    expect(intro).toContain('### 코드 제목');
    expect(intro).toContain('### 다른 코드');
    expect(intro).toContain('### 들여쓴 코드');
    expect(intro).toContain('<blockquote>');
    expect(sections[0].html).toContain('href="https://example.com"');
  });
  it('제목 링크·강조·코드를 보존하며 plain 제목으로 규칙과 키를 판정한다', () => {
    const s = mdSections('### [**필요한 결정** `A`](https://example.com)\n본문').sections[0];
    expect(s.title).toBe('필요한 결정 A');
    expect(s.open).toBe(true);
    expect(s.titleHtml).toContain('href="https://example.com"');
    expect(s.titleHtml).toContain('<strong>필요한 결정</strong>');
    expect(s.titleHtml).toContain('<code>A</code>');
    expect(s.titleHtml).toContain('target="_blank"');
  });
  it('h1·h2는 앞 h3의 접힘에 포함하지 않고 행동 하위 제목은 부모 섹션을 펼친다', () => {
    const { sections } = mdSections('### 배경\n정보\n\n## 상위 제목\n바깥 내용\n\n### 구현\n#### 꼭 확인할 일\n행동\n\n# 또 다른 상위\n끝');
    expect(sections[0].html).not.toContain('상위 제목');
    expect(sections[0].after).toContain('<h2>상위 제목</h2>');
    expect(sections[0].after).toContain('바깥 내용');
    expect(sections[1].open).toBe(true);
    expect(sections[1].html).toContain('<h4>꼭 확인할 일</h4>');
    expect(sections[1].html).not.toContain('또 다른 상위');
    expect(sections[1].after).toContain('<h1>또 다른 상위</h1>');
    expect(mdSections('### 확인한 근거\n본문\n### 결정 기록\n기록').sections.every(s => !s.open)).toBe(true);
  });
  it('같은 이름의 소제목도 서로 다른 상태 키를 가진다', () => {
    const { sections } = mdSections('### 배경\n첫째\n\n### 배경\n둘째');
    expect(sections[0].key).not.toBe(sections[1].key);
    expect(mdSections('### ---\n본문').sections[0].title).toBe('---');
    expect(mdSections('### [추천][ref]\n내용\n\n[ref]: https://example.com').sections[0].title).toBe('추천');
  });
});

describe('mdActionCount', () => {
  it('빈 본문과 중첩·코드 제목을 제외하고 같은 렌더링 섹션 단위로 센다', () => {
    expect(mdActionCount(undefined, null, '', '### 배경\n정보')).toBe(0);
    expect(mdActionCount('### 검토\n#### 다음 행동\n행동\n#### 꼭 확인\n행동', '### 추천\n행동')).toBe(2);
    expect(mdActionCount('```\n### 필요한 결정\n```\n\n> ### 다음 행동\n인용')).toBe(0);
  });
});
