import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure, validateConfig, verifyManifest } from './configure.mjs';

test('미설정은 실패하고 API 기본값이 없다', async () => {
  const lib = await import('./lib.js');
  assert.equal(lib.API, '');
  assert.throws(() => lib.requireConfig(), /설정이 비어/);
  assert.throws(() => validateConfig(), /설정/);
});
test('호스트·owner·Jira 입력은 정규화 전부터 한 이름만 허용한다', () => {
  const good = { api: 'https://dashboard.example.test', owner: 'example-org' };
  for (const api of ['http://*', 'http://*.example.com', 'http://*.example.com:48901', 'http://example?.com',
    'http://example..com', 'http://.example.com', 'http://example.com.', 'http://-bad.example', 'http://bad-.example',
    'http://example.com/path/..', 'http://example.com/%2e%2e', 'http://example.com\\path', 'http://%65xample.com',
    ' http://example.com', 'http://example.com ', 'http://exa mple.com', 'http://exa\tmple.com', 'http://example.com\n',
    'http://example.com:0', 'http://example.com:65536', 'http://example.com:080', 'http://example.com:',
    'http://[::1]', 'http://[2001:db8::1]:48901', 'http://::1', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://127.000.0.1',
    'https://예시.example', 'https://xn--9n2bp8q.example', 'https://EXAMPLE.xn--p1ai', 'https://' + 'a'.repeat(64) + '.example',
    null, 123, ['http://example.com']]) assert.throws(() => validateConfig({ ...good, api }), String(api));
  for (const owner of ['a?b', 'a*b', 'a..b', 'a/b', 'a\\b', 'a\nb', 'abc\n', 'abc\r', 'abc\0', 'a\tb', 'a b', 'a.', '예시', 'xn--example', 'XN--Example', null, 123])
    assert.throws(() => validateConfig({ ...good, owner }), String(owner));
  for (const jira of ['https://*.atlassian.net', 'https://example?.atlassian.net', 'https://example..atlassian.net',
    'https://example.atlassian.net.', 'https://example.atlassian.net/a/..', 'https://example.atlassian.net/%2e%2e',
    'https://example.atlassian.net:0', 'https://example.atlassian.net:65536', 'https://example.atlassian.net:8443',
    'https://example.\natlassian.net', 'https://예시.atlassian.net', 'https://xn--9n2bp8q.atlassian.net', 'https://[::1]', null])
    assert.throws(() => validateConfig({ ...good, jira }), String(jira));
});
test('ASCII DNS·localhost·정규 IPv4와 유효 포트는 같은 단일 호스트로 구성한다', () => {
  for (const [api, expected] of [['http://localhost:1', 'http://localhost:1'], ['http://127.0.0.1:65535/', 'http://127.0.0.1:65535'],
    ['HTTPS://DASHBOARD.Example.TEST:443', 'https://dashboard.example.test'], ['http://dashboard', 'http://dashboard'],
    ['https://a-b.example.test:8443', 'https://a-b.example.test:8443']]) {
    assert.equal(validateConfig({ api, owner: 'Example-Org' }).api, expected);
  }
  assert.equal(validateConfig({ api: 'http://localhost', owner: 'A', jira: 'https://EXAMPLE.atlassian.net/' }).jiraHost, 'example.atlassian.net');
});
test('설정은 origin과 단일 owner를 엄격히 검증한다', () => {
  assert.deepEqual(validateConfig({ api: 'http://127.0.0.1:48901/', owner: 'Example-Org' }), { api: 'http://127.0.0.1:48901', owner: 'example-org', jiraHost: '' });
  for (const api of ['file:///tmp', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#x'])
    assert.throws(() => validateConfig({ api, owner: 'example-org' }));
  for (const owner of ['', '*', 'a/b', 'a.b', 'two owners', '-bad']) assert.throws(() => validateConfig({ api: 'http://127.0.0.1:48901', owner }));
  assert.throws(() => validateConfig({ api: 'http://127.0.0.1:48901', owner: 'example-org', jira: 'https://evil.example' }));
});
test('manifest의 추가 호스트·wildcard·다른 owner와 선택 권한 확대는 최종 검사에서 실패한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-permissions-'));
  try {
    const config = configure({ api: 'https://dashboard.example.test', owner: 'example-org' }, dir);
    const good = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
    for (const change of [m => m.host_permissions.push('https://other.example.test/*'),
      m => m.host_permissions = ['https://*.example.test/*'], m => m.host_permissions = ['<all_urls>'],
      m => m.content_scripts[0].matches = ['https://github.com/*'], m => m.content_scripts[0].matches.push('https://github.com/other/*'),
      m => m.optional_host_permissions = ['https://*/*'], m => m.optional_permissions = ['tabs']]) {
      const bad = structuredClone(good); change(bad); assert.throws(() => verifyManifest(bad, config));
    }
    assert.throws(() => verifyManifest(good, { ...config, api: 'https://*.example.test' }));
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('구성기 자체가 저장한 manifest를 재검사하고 변조된 결과는 설치할 수 없게 한다', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-output-check-'));
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (path.basename(String(file)) === 'manifest.json') {
      const manifest = JSON.parse(data); manifest.host_permissions = ['http://*/*']; data = JSON.stringify(manifest);
    }
    return write(file, data, ...rest);
  });
  try {
    assert.throws(() => configure({ api: 'http://localhost:48901', owner: 'example-org' }, dir), /manifest/);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('생성 manifest와 코드 설정이 일치하고 key와 Jira 권한을 만들지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-config-'));
  try {
    const c = configure({ api: 'https://dashboard.example.test', owner: 'example-org', jira: 'https://example.atlassian.net' }, dir);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
    assert.equal(m.key, undefined);
    assert.deepEqual(m.host_permissions, [c.api + '/*']);
    assert.deepEqual(m.content_scripts[0].matches, ['https://github.com/example-org/*']);
    assert.equal(m.content_scripts[0].js[0], 'owner.js');
    assert.deepEqual((await import('file://' + path.join(dir, 'config.js'))).CONFIG, c);
    assert.throws(() => configure(c, dir), /비어/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
