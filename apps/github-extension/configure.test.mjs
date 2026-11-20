import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure, validateConfig } from './configure.mjs';

test('미설정은 실패하고 API 기본값이 없다', async () => {
  const lib = await import('./lib.js');
  assert.equal(lib.API, '');
  assert.throws(() => lib.requireConfig(), /설정이 비어/);
  assert.throws(() => validateConfig(), /설정/);
});
test('설정은 origin과 단일 owner를 엄격히 검증한다', () => {
  assert.deepEqual(validateConfig({ api: 'http://127.0.0.1:48901/', owner: 'Example-Org' }), { api: 'http://127.0.0.1:48901', owner: 'example-org', jiraHost: '' });
  for (const api of ['file:///tmp', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#x'])
    assert.throws(() => validateConfig({ api, owner: 'example-org' }));
  for (const owner of ['', '*', 'a/b', 'a.b', 'two owners', '-bad']) assert.throws(() => validateConfig({ api: 'http://127.0.0.1:48901', owner }));
  assert.throws(() => validateConfig({ api: 'http://127.0.0.1:48901', owner: 'example-org', jira: 'https://evil.example' }));
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
