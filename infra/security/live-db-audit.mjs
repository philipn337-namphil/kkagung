import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

// Invoked only by the isolated runner, never against an arbitrary DATABASE_URL.
const backend = resolve(process.argv[2] ?? '.');
const id = process.env.SECURITY_DB_RUN_ID;
const url = new URL(process.env.DATABASE_URL ?? 'file:///missing');
if (!/^[a-f0-9]{16}$/.test(id ?? '') || url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' ||
    url.pathname !== `/kkagung_security_${id}` || url.username !== 'kkagung_drill') {
  console.error('Refusing a database not created by the isolated runner'); process.exit(2);
}
const load = path => import(pathToFileURL(resolve(backend, path)).href);
const { app } = await load('src/app.ts');
const { prisma } = await load('src/prisma.ts');
const require = createRequire(resolve(backend, 'package.json'));
const { PrismaClient } = require('@prisma/client');
const evidence = { mode: 'real HTTP and MySQL', passed: [], failed: [] };
const server = await new Promise(done => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (path, token, body, method = body ? 'PUT' : 'GET') => {
  const result = await fetch(base + path, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: result.status, body: await result.json() };
};
const test = async (name, fn) => { try { await fn(); evidence.passed.push(name); } catch { evidence.failed.push(name); } };
let admin;
try {
  admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@kkagung.local' } });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'demo@kkagung.local' } });
  const tokenFor = async person => {
    const response = await fetch(`${base}/dev/test-accounts/${person.id}/token`, { method: 'POST' });
    assert.equal(response.status, 200); return (await response.json()).data.token;
  };
  const adminToken = await tokenFor(admin), userToken = await tokenFor(user);
  const first = { popularMinUniqueHearts: 21, popularMinUniqueChatRequests: 8, windowDays: 14 };
  const second = { popularMinUniqueHearts: 22, popularMinUniqueChatRequests: 9, windowDays: 15 };
  await test('current DB USER cannot change admin settings: 403', async () =>
    assert.equal((await call('/admin/settings/badge', userToken, first)).status, 403));
  await test('setting audit survives client reconnect and records actor plus before/after', async () => {
    const before = await prisma.adminAuditLog.count();
    assert.equal((await call('/admin/settings/badge', adminToken, first)).status, 200);
    const changed = await call('/admin/settings/badge', adminToken, second);
    assert.equal(changed.status, 200);
    const fresh = new PrismaClient();
    try {
      const audit = await fresh.adminAuditLog.findUniqueOrThrow({ where: { id: BigInt(changed.body.data.auditLogId) } });
      assert.equal(audit.adminId, admin.id); assert.equal(audit.action, 'SETTING_BADGE');
      assert.deepEqual(audit.beforeValue, first); assert.deepEqual(audit.afterValue, second);
      assert.equal(await fresh.adminAuditLog.count(), before + 2);
      assert.deepEqual((await call('/admin/settings', adminToken)).body.data.badge, second);
    } finally { await fresh.$disconnect(); }
  });
  await test('invalid setting produces no DB audit or setting mutation', async () => {
    const before = await prisma.adminAuditLog.count();
    const settings = (await call('/admin/settings', adminToken)).body.data.badge;
    assert.equal((await call('/admin/settings/badge', adminToken, { ...second, windowDays: -1 })).status, 400);
    assert.equal(await prisma.adminAuditLog.count(), before);
    assert.deepEqual((await call('/admin/settings', adminToken)).body.data.badge, settings);
  });
  await test('admin role revoked in DB invalidates already issued token: 403', async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    try { assert.equal((await call('/admin/settings', adminToken)).status, 403); }
    finally { await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } }); }
  });
  await test('admin suspended in DB invalidates already issued token: 403', async () => {
    await prisma.user.update({ where: { id: admin.id }, data: { status: 'SUSPENDED' } });
    try { assert.equal((await call('/admin/settings', adminToken)).status, 403); }
    finally { await prisma.user.update({ where: { id: admin.id }, data: { status: 'ACTIVE' } }); }
  });
  await test('both block directions reject new requests, acceptance and messages without DB writes', async () => {
    const partner = await prisma.user.findUniqueOrThrow({ where: { email: 'user4@kkagung.local' } });
    const partnerToken = await tokenFor(partner);
    await prisma.heart.create({ data: { senderId: partner.id, receiverId: user.id } });
    const request = await call('/chat-requests', userToken, { targetUserId: String(partner.id), message: 'synthetic security fixture' }, 'POST');
    assert.equal(request.status, 201);
    const accepted = await call(`/chat-requests/${request.body.data.requestId}/accept`, partnerToken, {}, 'POST');
    assert.equal(accepted.status, 201);
    const roomId = accepted.body.data.roomId;
    assert.equal((await call(`/chat-rooms/${roomId}/messages`, userToken, { body: 'synthetic baseline' }, 'POST')).status, 201);
    const pending = await prisma.chatRequest.create({ data: { senderId: user.id, receiverId: partner.id,
      message: 'pending synthetic fixture', sourceType: 'RECEIVED_HEART', serviceDate: new Date() } });
    for (const byMe of [true, false]) {
      const block = await prisma.block.create({ data: { blockerId: byMe ? user.id : partner.id, targetUserId: byMe ? partner.id : user.id } });
      try {
        const requestCount = await prisma.chatRequest.count(), messageCount = await prisma.chatMessage.count(), roomCount = await prisma.chatRoom.count();
        const denied = await call('/chat-requests', userToken, { targetUserId: String(partner.id), message: 'must be rejected' }, 'POST');
        assert.equal(denied.status, 403); assert.equal(denied.body.error.code, byMe ? 'TARGET_BLOCKED' : 'BLOCKED_BY_TARGET');
        assert.equal((await call(`/chat-rooms/${roomId}/messages`, userToken, { body: 'must be rejected' }, 'POST')).status, 403);
        assert.equal((await call(`/chat-requests/${pending.id}/accept`, partnerToken, {}, 'POST')).status, 403);
        assert.equal(await prisma.chatRequest.count(), requestCount); assert.equal(await prisma.chatMessage.count(), messageCount);
        assert.equal(await prisma.chatRoom.count(), roomCount);
        assert.equal((await prisma.chatRequest.findUniqueOrThrow({ where: { id: pending.id } })).status, 'PENDING');
      } finally { await prisma.block.delete({ where: { id: block.id } }); }
    }
  });
} catch { evidence.failed.push('live DB audit setup or unexpected error'); }
finally {
  await new Promise(done => server.close(done)); await prisma.$disconnect();
  writeFileSync(resolve(process.argv[3]), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.failed.length ? 1 : 0;
