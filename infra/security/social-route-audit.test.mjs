import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Read Git objects only. Never merge, check out or edit the other role's source.
const revision = process.env.SOCIAL_AUDIT_REVISION || 'e24bcd3f993bb80a5dfd6675a8c1dc35e03c40e0';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'backend/package.json'));
const ts = require('typescript');
const express = require('express');
const sources = {};
const cache = new Map();
const state = { actor: 1n, blocks: [], statuses: {}, writes: 0 };
const now = new Date('2026-10-25T00:00:00Z');
const profile = { displayName: 'Fixture', birthDate: new Date('2000-01-01'), gender: 'MALE', regionCode: 'TEST', heightCm: 175, jobCategory: 'STUDENT', mbti: 'INTJ', intro: 'Test', smokingStatus: null, tattooStatus: null, militaryService: null, celebrityLookalike: null };
const matchingBlocks = ({ where }) => state.blocks.filter(block =>
  (where.OR ?? [where]).some(condition => Object.entries(condition).every(([key, value]) => block[key] === value)));
const tx = {
  $queryRaw: async () => [],
  chatRequest: {
    findFirst: async () => null,
    create: async () => { state.writes++; return { id: 11n, status: 'PENDING', createdAt: now }; },
    updateMany: async () => { state.writes++; return { count: 1 }; },
  },
  chatRoom: { create: async () => { state.writes++; return { id: 301n }; } },
  chatRoomMember: { createMany: async () => { state.writes++; return { count: 2 }; } },
};
const prisma = {
  user: { findUnique: async ({ where }) => ({ id: where.id, role: 'USER', status: state.statuses[String(where.id)] ?? 'ACTIVE', profile }) },
  block: { findMany: async args => matchingBlocks(args), count: async args => matchingBlocks(args).length },
  recommendationItem: { count: async () => 1 },
  heart: { count: async () => 0 },
  chatRequest: {
    findUnique: async () => ({ id: 11n, senderId: 2n, receiverId: 1n, status: 'PENDING' }),
  },
  chatRoom: { findUnique: async ({ where }) => where.id === 301n ? { id: 301n, createdAt: now, chatRequest: { status: 'ACCEPTED' }, members: [{ userId: 1n, lastReadMessageId: null }, { userId: 2n, lastReadMessageId: null }] } : null },
  chatMessage: {
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [{ id: 1n, senderId: 2n, body: 'Fixture history', createdAt: now }],
    create: async ({ data }) => { state.writes++; return { id: 51n, ...data, createdAt: now }; },
  },
  $transaction: async callback => callback(tx),
};
prisma.block.findUnique = async ({ where }) => matchingBlocks({ where: where.blockerId_targetUserId })[0] ?? null;
prisma.block.create = async ({ data }) => {
  const row = { id: 91n, ...data, createdAt: now };
  state.blocks.push(row);
  state.writes++;
  return row;
};
prisma.block.deleteMany = async ({ where }) => {
  const count = matchingBlocks({ where }).length;
  state.blocks = state.blocks.filter(row => !(row.blockerId === where.blockerId && row.targetUserId === where.targetUserId));
  return { count };
};
prisma.chatRoomMember = { count: async ({ where }) => [1n, 2n].includes(where.userId) ? 1 : 0 };
tx.report = {
  findFirst: async () => state.duplicate ? { id: 71n } : null,
  create: async ({ data }) => { state.writes++; return { id: 71n, status: 'PENDING', createdAt: now, ...data }; },
};
const response = {
  fail: (res, status, code, message) => res.status(status).json({ success: false, data: null, error: { code, message } }),
  ok: (res, data, status = 200) => res.status(status).json({ success: true, data: JSON.parse(JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value)), error: null }),
};
function load(path) {
  if (cache.has(path)) return cache.get(path);
  const source = execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' });
  sources[path] = createHash('sha256').update(source).digest('hex');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  cache.set(path, module.exports);
  const resolveImport = name => {
    if (name === '../lib/objectStorage.js') return { storageReady: () => false, privateObjectUrl: async () => { throw new Error('Storage disabled in route-only fixture'); } };
    if (name === '../middleware/auth.js') return { requireAuth: (req, _res, next) => { req.auth = { userId: state.actor, role: 'USER' }; next(); } };
    if (name === '../prisma.js') return { prisma };
    if (name === '../lib/response.js') return response;
    if (name === '../lib/recommendation.js') return {
      serviceDateOf: () => '2026-10-25', fortuneDateOf: () => now,
      buildPublicCards: async () => [{ userId: '2', displayName: 'Fixture' }],
    };
    if (name === './hearts.js') return load('backend/src/routes/hearts.ts');
    if (!name.startsWith('.')) return require(name);
    throw new Error('Unexpected route dependency: ' + name);
  };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: path })(resolveImport, module, module.exports);
  cache.set(path, module.exports);
  return module.exports;
}
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/chat-requests', load('backend/src/routes/chatRequests.ts').chatRequestsRouter);
  app.use('/api/v1/chat-rooms', load('backend/src/routes/chatRooms.ts').chatRoomsRouter);
  app.use('/api/v1/blocks', load('backend/src/routes/blocks.ts').blocksRouter);
  app.use('/api/v1/reports', load('backend/src/routes/reports.ts').reportsRouter);
  app.use((error, _req, res, _next) => response.fail(res, 500, 'TEST_ERROR', 'Synthetic fixture error'));
  server = await new Promise(resolveServer => { const started = app.listen(0, '127.0.0.1', () => resolveServer(started)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  state.actor = 1n; state.blocks = []; state.statuses = {}; state.writes = 0; state.duplicate = false;
  prisma.chatMessage.findUnique = async () => null;
});
after(async () => {
  if (server) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  const evidenceName = process.env.SOCIAL_AUDIT_FIXED === '1' ? 'social-fixed-source-provenance.json' : 'social-source-provenance.json';
  writeFileSync(resolve(root, 'infra/security/evidence', evidenceName), JSON.stringify({ revision, mode: 'unchanged Git route source; mocked authentication actor, Prisma, card builder; real Express HTTP; NOT integrated JWT or DB verification', sourceHashes: sources }, null, 2) + '\n');
});
async function call(path, body) {
  const result = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: result.status, body: await result.json(), cache: result.headers.get('cache-control') };
}
const blocked = blockerId => { state.blocks = [{ blockerId, targetUserId: blockerId === 1n ? 2n : 1n }]; };

for (const blocker of [1n, 2n]) {
  test(`blocked pair ${blocker} cannot create a new chat request`, async () => {
    blocked(blocker);
    assert.equal((await call('/api/v1/chat-requests', { targetUserId: '2', message: 'Fixture' })).status, 403);
    assert.equal(state.writes, 0);
  });
  test(`blocked pair ${blocker} cannot send a new message`, async () => {
    blocked(blocker);
    assert.equal((await call('/api/v1/chat-rooms/301/messages', { body: 'Fixture' })).status, 403);
    assert.equal(state.writes, 0);
  });
}
test('third party cannot accept another users request', async () => {
  state.actor = 3n;
  assert.equal((await call('/api/v1/chat-requests/11/accept', {})).status, 403);
  assert.equal(state.writes, 0);
});
test('request sender cannot accept their own outgoing request', async () => {
  state.actor = 2n;
  assert.equal((await call('/api/v1/chat-requests/11/accept', {})).status, 403);
});
test('legitimate receiver can accept an unblocked request', async () => {
  assert.equal((await call('/api/v1/chat-requests/11/accept', {})).status, 201);
  assert.ok(state.writes > 0);
});
for (const blocker of [1n, 2n]) {
  test(`receiver must not accept while block ${blocker} remains`, async () => {
    blocked(blocker);
    const result = await call('/api/v1/chat-requests/11/accept', {});
    assert.deepEqual({ status: result.status, writes: state.writes }, { status: 403, writes: 0 });
  });
}
test('third party cannot read chat room or messages or send', async () => {
  state.actor = 3n;
  assert.equal((await call('/api/v1/chat-rooms/301')).status, 403);
  assert.equal((await call('/api/v1/chat-rooms/301/messages')).status, 403);
  assert.equal((await call('/api/v1/chat-rooms/301/messages', { body: 'Fixture' })).status, 403);
});
test('suspended sender cannot send a message', async () => {
  state.statuses['1'] = 'SUSPENDED';
  assert.equal((await call('/api/v1/chat-rooms/301/messages', { body: 'Fixture' })).status, 403);
});
test('withdrawn partner cannot receive a new message', async () => {
  state.statuses['2'] = 'WITHDRAWN';
  assert.equal((await call('/api/v1/chat-rooms/301/messages', { body: 'Fixture' })).status, 403);
});
test('chat-restricted sender cannot send', async () => {
  state.statuses['1'] = 'CHAT_RESTRICTED';
  assert.equal((await call('/api/v1/chat-rooms/301/messages', { body: 'Fixture' })).status, 403);
});
test('unblocked room participant can send', async () => {
  assert.equal((await call('/api/v1/chat-rooms/301/messages', { body: 'Fixture' })).status, 201);
});
test('existing participant can read prior history after a block', async () => {
  blocked(2n);
  assert.equal((await call('/api/v1/chat-rooms/301/messages')).status, 200);
});
test('blocked room disables messaging and returns no original URLs', async () => {
  blocked(1n);
  const result = await call('/api/v1/chat-rooms/301');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.canSendMessage, false);
  assert.deepEqual(result.body.data.partner.originalImages, []);
  assert.equal(result.cache, 'no-store');
});

test('self block is rejected without writes', async () => {
  assert.equal((await call('/api/v1/blocks', { targetUserId: '1' })).status, 400);
  assert.equal(state.writes, 0);
});
test('block API prevents subsequent new requests', async () => {
  assert.equal((await call('/api/v1/blocks', { targetUserId: '2' })).status, 201);
  assert.equal((await call('/api/v1/chat-requests', { targetUserId: '2', message: 'Fixture' })).status, 403);
});
test('repeated block does not create duplicate writes', async () => {
  await call('/api/v1/blocks', { targetUserId: '2' });
  await call('/api/v1/blocks', { targetUserId: '2' });
  assert.equal(state.writes, 1);
});
test('user cannot delete another users block', async () => {
  blocked(2n);
  const result = await fetch(base + '/api/v1/blocks/2', { method: 'DELETE' });
  assert.equal(result.status, 404);
  assert.equal(state.blocks.length, 1);
});
test('self report is rejected without writes', async () => {
  assert.equal((await call('/api/v1/reports', { targetType: 'USER', targetId: '1', reasonCode: 'SPAM' })).status, 400);
  assert.equal(state.writes, 0);
});
test('nonmember cannot report a private message', async () => {
  state.actor = 3n;
  prisma.chatMessage.findUnique = async () => ({ roomId: 301n, senderId: 2n });
  assert.equal((await call('/api/v1/reports', { targetType: 'MESSAGE', targetId: '51', reasonCode: 'SPAM' })).status, 404);
  assert.equal(state.writes, 0);
});
test('member can report a message with no handler details returned', async () => {
  prisma.chatMessage.findUnique = async () => ({ roomId: 301n, senderId: 2n });
  const result = await call('/api/v1/reports', { targetType: 'MESSAGE', targetId: '51', reasonCode: 'SPAM' });
  assert.equal(result.status, 201);
  assert.deepEqual(Object.keys(result.body.data).sort(), ['createdAt', 'reportId', 'status']);
});
test('duplicate pending report is rejected without writes', async () => {
  state.duplicate = true;
  assert.equal((await call('/api/v1/reports', { targetType: 'USER', targetId: '2', reasonCode: 'SPAM' })).status, 409);
  assert.equal(state.writes, 0);
});
