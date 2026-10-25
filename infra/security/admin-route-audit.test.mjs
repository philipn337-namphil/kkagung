import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const revision = process.env.ADMIN_AUDIT_REVISION || 'cc021c7';
const require = createRequire(resolve(root, 'backend/package.json'));
const ts = require('typescript');
const express = require('express');
const sourceHashes = {};
const state = { role: 'ADMIN', status: 'ACTIVE', logs: [], writes: 0, previous: {}, options: null };
const environment = { NODE_ENV: process.env.NODE_ENV, APP_ENV: process.env.APP_ENV, ADMIN_ALLOWED_IP_CIDRS: process.env.ADMIN_ALLOWED_IP_CIDRS };
const tx = {
  adminSetting: {
    findFirst: async ({ where }) => state.previous[where.settingKey] === undefined ? null : { settingValue: state.previous[where.settingKey] },
    upsert: async () => { state.writes++; return {}; },
  },
  adminAuditLog: { create: async ({ data }) => { state.logs.push(data); return { id: 91n }; } },
};
const prisma = {
  user: { findUnique: async () => ({ id: 1n, role: state.role, status: state.status }) },
  $transaction: async (operation, options) => { state.options = options; return operation(tx); },
};
const response = {
  fail: (res, status, code, message) => res.status(status).json({ success: false, data: null, error: { code, message } }),
  ok: (res, data, status = 200) => res.status(status).json({ success: true, data, error: null }),
};
const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path);
  const source = execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' });
  sourceHashes[path] = createHash('sha256').update(source).digest('hex');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const resolveImport = name => {
    if (name === '../middleware/auth.js') return { requireAuth: (req, _res, next) => { req.auth = { userId: 1n, role: 'ADMIN' }; next(); } };
    if (name === '../prisma.js') return { prisma };
    if (name === '../lib/response.js' || name === './response.js') return response;
    if (name === '../lib/admin.js') return load('backend/src/lib/admin.ts');
    if (name === '../lib/recommendation.js') return { serviceDateOf: () => '2026-10-25', fortuneDateOf: value => new Date(`${value}T00:00:00Z`) };
    if (name === './hearts.js') return { decodeCursor: () => null, encodeCursor: String, parseLimit: () => 20 };
    if (!name.startsWith('.')) return require(name);
    throw new Error('Unexpected dependency: ' + name);
  };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: path })(resolveImport, module, module.exports);
  cache.set(path, module.exports);
  return module.exports;
}
let server, base;
before(async () => {
  const app = express(); app.use(express.json());
  app.use('/api/v1/admin', load('backend/src/routes/admin.ts').adminRouter);
  app.use((_error, _req, res, _next) => response.fail(res, 500, 'FIXTURE_ERROR', 'Synthetic fixture error'));
  server = await new Promise(done => { const running = app.listen(0, '127.0.0.1', () => done(running)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  state.role = 'ADMIN'; state.status = 'ACTIVE'; state.logs = []; state.writes = 0; state.previous = {}; state.options = null;
  process.env.NODE_ENV = 'development'; process.env.APP_ENV = 'development'; process.env.ADMIN_ALLOWED_IP_CIDRS = '127.0.0.1';
});
after(async () => {
  if (server) await new Promise(done => server.close(done));
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const resolvedRevision = execFileSync('git', ['rev-parse', revision], { cwd: root, encoding: 'utf8' }).trim();
  const name = process.env.ADMIN_AUDIT_FIXED === '1' ? 'admin-fixed-source-provenance.json' : 'admin-source-provenance.json';
  writeFileSync(resolve(root, 'infra/security/evidence', name), JSON.stringify({ revision: resolvedRevision, mode: 'unchanged Git admin routes and helper; real Express; mocked auth actor, Prisma transaction and date; NOT durable audit, JWT or DB integration', sourceHashes }, null, 2) + '\n');
});
const changeBadge = headers => fetch(base + '/api/v1/admin/settings/badge', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ popularMinUniqueHearts: 11, popularMinUniqueChatRequests: 6, windowDays: 30 }),
});
test('USER cannot change admin settings despite stale ADMIN auth actor', async () => {
  state.role = 'USER'; assert.equal((await changeBadge()).status, 403); assert.equal(state.writes, 0);
});
for (const status of ['SUSPENDED', 'WITHDRAWN', 'CHAT_RESTRICTED']) test(`${status} admin is rejected`, async () => {
  state.status = status; assert.equal((await changeBadge()).status, 403); assert.equal(state.writes, 0);
});
test('production without an address allowlist denies admin writes', async () => {
  process.env.NODE_ENV = 'production'; process.env.ADMIN_ALLOWED_IP_CIDRS = '';
  assert.equal((await changeBadge()).status, 403);
});
test('spoofed forwarded address does not bypass direct address allowlist', async () => {
  process.env.ADMIN_ALLOWED_IP_CIDRS = '192.0.2.1';
  assert.equal((await changeBadge({ 'X-Forwarded-For': '192.0.2.1' })).status, 403);
});
test('allowed ACTIVE admin writes settings and an audit entry in the callback', async () => {
  assert.equal((await changeBadge()).status, 200); assert.equal(state.writes, 3); assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].action, 'SETTING_BADGE'); assert.equal(state.logs[0].adminId, 1n);
  assert.equal(state.logs[0].afterValue.popularMinUniqueHearts, 11);
});
test('badge settings audit must contain previous values', async () => {
  assert.equal((await changeBadge()).status, 200);
  assert.notEqual(state.logs[0].beforeValue, undefined);
});
test('invalid empty CIDR prefix must fail closed', () => {
  process.env.ADMIN_ALLOWED_IP_CIDRS = '127.0.0.1/';
  assert.equal(load('backend/src/lib/admin.ts').isAllowedAddress({ socket: { remoteAddress: '192.0.2.2' } }), false);
});
for (const entry of ['127.0.0.1/-1', '127.0.0.1/33', '127.0.0.1/1/2', '999.0.0.1/8', '127.0.0.1/1e1', '127.0.0.1,', '127.0.0.1,not-an-address']) {
  test(`malformed allowlist is denied: ${entry}`, () => {
    process.env.ADMIN_ALLOWED_IP_CIDRS = entry;
    assert.equal(load('backend/src/lib/admin.ts').isAllowedAddress({ socket: { remoteAddress: '127.0.0.1' } }), false);
  });
}
test('valid IPv4 subnet allows a member and denies a nonmember', () => {
  process.env.ADMIN_ALLOWED_IP_CIDRS = '192.0.2.0/24';
  const allowed = load('backend/src/lib/admin.ts').isAllowedAddress;
  assert.equal(allowed({ socket: { remoteAddress: '::ffff:192.0.2.12' } }), true);
  assert.equal(allowed({ socket: { remoteAddress: '192.0.3.12' } }), false);
});
test('badge audit uses effective defaults when there are no previous rows', async () => {
  assert.equal((await changeBadge()).status, 200);
  assert.deepEqual(state.logs[0].beforeValue, { popularMinUniqueHearts: 10, popularMinUniqueChatRequests: 5, windowDays: 30 });
});
test('badge audit reads existing values and requests serializable isolation', async () => {
  state.previous = { BADGE_POPULAR_MIN_UNIQUE_HEARTS: 18, BADGE_POPULAR_MIN_UNIQUE_CHAT_REQUESTS: 8, BADGE_POPULAR_WINDOW_DAYS: 60 };
  assert.equal((await changeBadge()).status, 200);
  assert.deepEqual(state.logs[0].beforeValue, { popularMinUniqueHearts: 18, popularMinUniqueChatRequests: 8, windowDays: 60 });
  assert.deepEqual(state.options, { isolationLevel: 'Serializable' });
});
