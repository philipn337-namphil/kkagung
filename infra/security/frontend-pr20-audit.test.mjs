import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import vm from 'node:vm';

const revision = process.env.FRONTEND_AUDIT_REVISION || 'ef1f722636d69f9cdd02bb67fb7ead1403b2fd89';
const source = execFileSync('git', ['show', `${revision}:frontend/app.js`], { encoding: 'utf8' });
const evidenceName = process.env.FRONTEND_AUDIT_FIXED === '1' ? 'frontend-security-fixed-provenance.json' : 'frontend-pr20-provenance.json';
writeFileSync(new URL('evidence/' + evidenceName, import.meta.url), JSON.stringify({ revision, sourceHash: createHash('sha256').update(source).digest('hex'), mode: 'unchanged app.js in VM; fake DOM/storage/fetch; renderer output and callback behavior only, NOT browser script execution or live backend' }, null, 2) + '\n');
function fixture(status = 200) {
  const calls = [], removed = [], app = { innerHTML: '' }, logout = { handler: null, addEventListener: (_name, handler) => { logout.handler = handler; } };
  const context = vm.createContext({
    window: { addEventListener: () => {}, scrollTo: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: key => removed.push(key) },
    location: { hash: '#/' },
    document: { querySelector: selector => selector === '#app' ? app : selector === '#logout' ? logout : null },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (status === 0) throw new Error('Synthetic network fixture');
      return { ok: status >= 200 && status < 300, status, json: async () => ({ success: status === 200, data: {}, error: { code: 'FIXTURE_ERROR', message: 'Synthetic fixture' } }) };
    },
  });
  vm.runInContext(source, context);
  return { calls, removed, logout, run: script => vm.runInContext(script, context) };
}
test('profile text and textarea escape HTML payload', () => {
  const f = fixture(); const marker = '<img data-security-test=fixture>';
  const html = f.run(`state.me={profile:{displayName:${JSON.stringify(marker)},intro:${JSON.stringify(marker)}}}; profile();`);
  assert.equal(html.includes(marker), false);
});
for (const status of [401, 403, 404, 409, 429]) test(`admin API ${status} is not converted to mock success`, async () => {
  await assert.rejects(() => fixture(status).run("api.admin('dashboard')"));
});
test('server logout failure must retain token for revocation retry', async () => {
  const f = fixture(500); f.run("state.token='synthetic-token'; state.user={id:'1',role:'USER'};");
  await f.logout.handler();
  assert.equal(f.removed.length, 0);
  assert.equal(f.run('state.token !== null'), true);
});
test('network failure must not report successful server logout', async () => {
  await assert.rejects(() => fixture(0).run('api.logout()'));
});
test('public card renderer refuses an ORIGINAL_PRIVATE image type', () => {
  const url = 'https://example.invalid/private/synthetic';
  const html = fixture().run(`cardAvatar({displayName:'Fixture',publicImage:{type:'ORIGINAL_PRIVATE',url:${JSON.stringify(url)}}})`);
  assert.equal(html.includes(url), false);
});
test('untrusted card color must not create raw HTML', () => {
  const marker = '"><img data-security-test=fixture>';
  const html = fixture().run(`cardAvatar({displayName:'Fixture',color:${JSON.stringify(marker)}})`);
  assert.equal(html.includes(marker), false);
});
test('chat message request follows backend body field contract', async () => {
  const f = fixture(); await f.run("api.sendMessage('301','Fixture message')");
  assert.equal(JSON.parse(f.calls[0].options.body).body, 'Fixture message');
});
test('image status request follows implemented endpoint', async () => {
  const f = fixture(); await f.run('api.imageStatus()');
  assert.equal(f.calls[0].url.endsWith('/me/images/status'), true);
});
