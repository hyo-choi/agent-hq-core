import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// URL 정규화 전에 authority와 경로를 제한한다. 권한 패턴, IDN 변환, 축약 IP를 URL parser에 맡기지 않는다.
function literalOrigin(value) {
  if (typeof value !== 'string' || /[^\x21-\x7e]/.test(value)) throw new Error('URL은 공백·제어 문자 없는 ASCII origin이어야 합니다');
  const match = /^(https?):\/\/([A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?\/?$/i.exec(value);
  if (!match) throw new Error('URL은 패턴·사용자 정보·경로·query·hash·IPv6 없는 http(s) origin이어야 합니다');
  const [, , host, port] = match, labels = host.toLowerCase().split('.');
  if (host.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || label.startsWith('xn--')))
    throw new Error('호스트는 빈 라벨·끝 점·IDN/punycode 없는 ASCII 이름이어야 합니다');
  if ((port && Number(port) > 65535) || (/^[0-9.]+$/.test(host) && isIP(host) !== 4)) throw new Error('포트는 1~65535, IPv4는 정규 점 표기여야 합니다');
  let url;
  try { url = new URL(value); } catch { throw new Error('URL 형식 오류'); }
  if (url.hostname !== host.toLowerCase()) throw new Error('정규화로 호스트가 바뀌는 주소는 허용하지 않습니다');
  return url;
}
export function validateConfig({ api = '', owner = '', jira = '' } = {}) {
  if (api === '') throw new Error('진행판 URL과 GitHub owner를 설정해야 합니다');
  const url = literalOrigin(api);
  if (typeof owner !== 'string' || /[^\x21-\x7e]/.test(owner) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || /^xn--/i.test(owner))
    throw new Error('GitHub owner는 IDN/punycode·패턴 없는 ASCII 이름 하나여야 합니다');
  let jiraHost = '';
  if (jira !== '') {
    const u = literalOrigin(jira);
    if (u.protocol !== 'https:' || u.port || !/^[a-z0-9-]+\.atlassian\.net$/.test(u.hostname))
      throw new Error('Jira URL은 https://<사이트>.atlassian.net 형식이어야 합니다');
    jiraHost = u.hostname;
  }
  return { api: url.origin, owner: owner.toLowerCase(), jiraHost };
}
export function verifyManifest(manifest, config) {
  const checked = validateConfig({ api: config.api, owner: config.owner });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(manifest.host_permissions, [`${checked.api}/*`]) ||
      !same(manifest.content_scripts, [{ matches: [`https://github.com/${checked.owner}/*`], js: ['owner.js', 'list-button.js', 'pr-links.js', 'comment-button.js'] }]) ||
      !same(manifest.permissions, ['activeTab', 'storage']) ||
      (manifest.optional_host_permissions !== undefined && !same(manifest.optional_host_permissions, [])) ||
      (manifest.optional_permissions !== undefined && !same(manifest.optional_permissions, [])))
    throw new Error('생성 manifest의 권한이 입력한 단일 호스트·owner 범위와 다릅니다');
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
  try {
    verifyManifest(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')), config);
  } catch (error) {
    // 검증 실패한 출력 폴더를 unpacked 확장으로 설치할 수 없게 한다.
    fs.unlinkSync(path.join(out, 'manifest.json'));
    throw error;
  }
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
