import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export function validateConfig({ api = '', owner = '', jira = '' } = {}) {
  let url;
  try { url = new URL(api); } catch { throw new Error('진행판 URL과 GitHub owner를 설정해야 합니다'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('진행판 URL은 사용자 정보·경로·query·hash 없는 http(s) origin이어야 합니다');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw new Error('GitHub owner 하나를 지정해야 합니다');
  let jiraHost = '';
  if (jira) {
    let u;
    try { u = new URL(jira); } catch { throw new Error('Jira URL 형식 오류'); }
    if (u.origin !== jira.replace(/\/$/, '') || !/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(u.origin))
      throw new Error('Jira URL은 https://<사이트>.atlassian.net 형식이어야 합니다');
    jiraHost = u.hostname;
  }
  return { api: url.origin, owner: owner.toLowerCase(), jiraHost };
}
export function configure(options, out = path.join(HERE, 'local', 'extension')) {
  const config = validateConfig(options);
  // 임의 폴더를 덮어쓰지 않는다. 재구성할 때는 새 폴더를 지정한다.
  if (fs.existsSync(out) && (fs.lstatSync(out).isSymbolicLink() || fs.readdirSync(out).length)) throw new Error('출력 폴더는 비어 있어야 합니다');
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['manifest.json', 'popup.html', 'popup.js', 'lib.js', 'sw.js', 'list-button.js', 'pr-links.js', 'comment-button.js', 'images.js', 'help.js']) {
    const source = path.join(HERE, name);
    fs.copyFileSync(source, path.join(out, name));
  }
  fs.writeFileSync(path.join(out, 'config.js'), `export const CONFIG = Object.freeze(${JSON.stringify(config)});\n`);
  fs.writeFileSync(path.join(out, 'owner.js'), `globalThis.AGENT_HQ_OWNER = ${JSON.stringify(config.owner)};\n`);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  delete manifest.key;
  manifest.host_permissions = [`${config.api}/*`];
  manifest.content_scripts = [{ matches: [`https://github.com/${config.owner}/*`], js: ['owner.js', 'list-button.js', 'pr-links.js', 'comment-button.js'] }];
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return config;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--api', '--owner', '--jira', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('사용법: node configure.mjs --api URL --owner OWNER [--jira URL] [--out 빈폴더]');
      options[args[i].slice(2)] = args[i + 1];
    }
    configure(options, options.out);
    console.log('확장 구성이 완료됐습니다. 출력 폴더를 Load unpacked로 설치하고 자신의 ID를 서버에 등록하세요.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
