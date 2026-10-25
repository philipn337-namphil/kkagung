import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { snapshotApp } from './snapshot-app.mjs';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const revision = process.env.MERGED_APP_REVISION || '1b02f98186fc7caa9f4ebf91f0b7a1b70b228c26';
const tested = snapshotApp(revision);
const production = snapshotApp(revision, true);
let server, prodServer, base, prodBase, password, passwordHash;
before(async () => {
  password = randomUUID(); passwordHash = await bcrypt.hash(password, 4);
  const start = app => new Promise(done => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
  server = await start(tested.app); prodServer = await start(production.app);
  base = `http://127.0.0.1:${server.address().port}`; prodBase = `http://127.0.0.1:${prodServer.address().port}`;
});
beforeEach(() => {
  process.env.NODE_ENV = 'development'; process.env.APP_ENV = 'development'; process.env.ADMIN_ALLOWED_IP_CIDRS = '127.0.0.1';
  for (const snapshot of [tested, production]) {
    snapshot.state.user = { id: 1n, email: 'fixture@kkagung.local', passwordHash, role: 'USER', status: 'ACTIVE', adultVerifiedAt: new Date(), profile: null, preference: null };
    snapshot.state.revoked.clear(); snapshot.state.counters.clear(); snapshot.state.audit = []; snapshot.state.settingWrites = 0;
  }
});
after(async () => {
  for (const listener of [server, prodServer]) if (listener) await new Promise(done => listener.close(done));
  const label = process.env.MERGED_APP_FIXED === '1' ? 'claims-pr19' : 'develop';
  writeFileSync(new URL(`evidence/merged-app-${label}-provenance.json`, import.meta.url), JSON.stringify({ revision, mode: 'unchanged whole Git app, real JWT/auth/admin middleware and Express HTTP; mock Prisma only; NOT MySQL persistence/concurrency', sourceHashes: tested.sourceHashes, productionSourceHashes: production.sourceHashes }, null, 2) + '\n');
});
const call = (path, token, body, origin = base, method = body === undefined ? 'GET' : 'POST') => fetch(origin + '/api/v1' + path, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sign = (claims = {}, options = {}) => jwt.sign({ sub: '1', role: 'USER', iss: tested.config.jwtIssuer, aud: tested.config.jwtAudience, jti: randomUUID(), ...claims }, tested.config.jwtSecret, { expiresIn: '15m', ...options });
async function login() {
  const response = await call('/auth/login', undefined, { email: 'fixture@kkagung.local', password });
  assert.equal(response.status, 200); return (await response.json()).data.token;
}
test('normal login token passes the merged /me middleware', async () => assert.equal((await call('/me', await login())).status, 200));
test('development account token must pass the same /me middleware', async () => {
  const response = await call('/dev/test-accounts/1/token', undefined, {});
  assert.equal(response.status, 200);
  const token = (await response.json()).data.token;
  assert.equal((await call('/me', token)).status, 200);
});
test('real admin endpoint rejects current USER despite stale ADMIN claim', async () => assert.equal((await call('/admin/settings/badge', sign({ role: 'ADMIN' }), { popularMinUniqueHearts: 11, popularMinUniqueChatRequests: 6 }, base, 'PUT')).status, 403));
test('ACTIVE admin setting change calls audit with before/after through actual auth', async () => {
  tested.state.user.role = 'ADMIN';
  const response = await call('/admin/settings/badge', await login(), { popularMinUniqueHearts: 11, popularMinUniqueChatRequests: 6 }, base, 'PUT');
  assert.equal(response.status, 200); assert.equal(tested.state.settingWrites, 3);
  assert.equal(tested.state.audit.length, 1); assert.equal(tested.state.audit[0].beforeValue.popularMinUniqueHearts, 10);
  assert.equal(tested.state.audit[0].afterValue.popularMinUniqueHearts, 11);
});
test('role revocation after login denies real admin endpoint', async () => {
  tested.state.user.role = 'ADMIN'; const token = await login(); tested.state.user.role = 'USER';
  assert.equal((await call('/admin/settings/badge', token, { popularMinUniqueHearts: 11, popularMinUniqueChatRequests: 6 }, base, 'PUT')).status, 403);
});
test('suspension after login rejects merged /me endpoint', async () => {
  const token = await login(); tested.state.user.status = 'SUSPENDED'; assert.equal((await call('/me', token)).status, 403);
});
test('expired token returns 401 on real admin endpoint', async () => assert.equal((await call('/admin/settings/badge', sign({}, { expiresIn: -1 }), {}, base, 'PUT')).status, 401));
test('forged token returns 401 on real admin endpoint', async () => assert.equal((await call('/admin/settings/badge', jwt.sign({ sub: '1' }, randomUUID()), {}, base, 'PUT')).status, 401));
test('server logout revokes login-issued token across actual middleware', async () => {
  const token = await login(); assert.equal((await call('/auth/logout', token, {})).status, 200); assert.equal((await call('/me', token)).status, 401);
});
test('production hides developer token route even with enable flag', async () => assert.equal((await call('/dev/test-accounts/1/token', undefined, {}, prodBase)).status, 404));
test('production refuses client-only adult verification in merged app', async () => assert.equal((await call('/auth/register', undefined, { email: 'fixture@example.invalid', password, adultVerified: true }, prodBase)).status, 403));
