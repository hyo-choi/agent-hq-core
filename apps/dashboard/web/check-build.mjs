// 빌드 산출물 검사: 서버가 재시작 없이 그대로 줄 수 있는 단일 파일인지 본다(정적 경로 allowlist·CSP 호환)
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const bad = [
  [/<script[^>]+\bsrc=/i, '외부 script src'],
  [/<link[^>]+rel=["']?(stylesheet|modulepreload|preload|icon)/i, '외부 link'],
  [/\b(src|href)=["'](?!#|https:\/\/|data:)[^"']+\.(js|css|mjs)["']/i, '로컬 자산 참조'],
  [/\beval\(|new Function\(/, 'eval(CSP unsafe-eval 없음)'],
];
const errs = bad.filter(([re]) => re.test(html)).map(([, m]) => m);
if (!/<style[^>]*>/.test(html) || !/<script type="module"[^>]*>/.test(html)) errs.push('inline style/module script 없음');
if (errs.length) { console.error('check-build 실패:', errs.join(', ')); process.exit(1); }
console.log(`check-build ok: public/index.html ${(html.length / 1024).toFixed(1)}KB 단일 파일`);
