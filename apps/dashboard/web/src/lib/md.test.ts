// Markdown 렌더 규칙: 지원 문법, raw HTML·위험 URL 차단, 이미지 미로드, 기존 plain 기록 호환
import { describe, expect, it } from 'vitest';
import { mdHtml, mdPlain } from './md';

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
