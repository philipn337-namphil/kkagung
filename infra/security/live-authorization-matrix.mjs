import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

// Never mutate an ambient developer/production database.
const backend = resolve(process.argv[2] ?? '.');
const runId = process.env.SECURITY_DB_RUN_ID;
const db = new URL(process.env.DATABASE_URL ?? 'file:///missing');
if (!/^[a-f0-9]{16}$/.test(runId ?? '') || db.protocol !== 'mysql:' || db.hostname !== '127.0.0.1' ||
    db.pathname !== `/kkagung_security_${runId}` || db.username !== 'kkagung_drill') {
  console.error('Refusing a database not created by the isolated runner'); process.exit(2);
}
const load = file => import(pathToFileURL(resolve(backend, file)).href);
const { app } = await load('src/app.ts');
const { prisma } = await load('src/prisma.ts');
const { issueAccessToken } = await load('src/lib/accessToken.ts');
const { fortuneDateOf, serviceDateOf } = await load('src/lib/recommendation.ts');
const states = ['ACTIVE', 'RECOMMENDATION_BLOCKED', 'CHAT_RESTRICTED', 'SUSPENDED', 'WITHDRAWN'];
// Fixed policy expectations, independent of the route's calculated response.
const authenticated = status => !['SUSPENDED', 'WITHDRAWN'].includes(status);
const publicTarget = status => ['ACTIVE', 'CHAT_RESTRICTED'].includes(status);
const senderAllowed = status => ['ACTIVE', 'RECOMMENDATION_BLOCKED'].includes(status);
const result = { recordedAt: new Date().toISOString(), mode: 'real HTTP / isolated MySQL / Moto S3 simulation',
  contexts: 0, passed: [], failed: [], cloudPolicyVerified: false, exhaustiveBeyondListedDimensions: false };
const test = async (name, fn) => { try { await fn(); result.passed.push(name); } catch (error) {
  result.failed.push({ name, kind: error.code ?? error.name,
    ...(['number', 'boolean'].includes(typeof error.actual) ? { actual: error.actual } : {}),
    ...(['number', 'boolean'].includes(typeof error.expected) ? { expected: error.expected } : {}) });
} };
const server = await new Promise(done => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (path, token, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), headers: response.headers };
};
let actor, target, admin;
try {
  actor = await prisma.user.findUniqueOrThrow({ where: { email: 'demo@kkagung.local' } });
  target = await prisma.user.findUniqueOrThrow({ where: { email: 'user4@kkagung.local' } });
  admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@kkagung.local' } });
  await prisma.user.updateMany({ where: { id: { in: [actor.id, target.id] } }, data: { status: 'ACTIVE', withdrawnAt: null } });
  const token = issueAccessToken(actor), adminToken = issueAccessToken(admin);
  const pair = { OR: [{ blockerId: actor.id, targetUserId: target.id }, { blockerId: target.id, targetUserId: actor.id }] };
  await prisma.block.deleteMany({ where: pair });
  await prisma.rateLimitCounter.deleteMany({});
  assert.equal((await call('/daily/open', token, 'POST', {})).status, 200);
  const day = fortuneDateOf(serviceDateOf(new Date())), yesterday = new Date(day.getTime() - 86400000);
  // Earlier audit suites use this same synthetic pair; isolate the matrix's own preconditions.
  await prisma.chatRequest.deleteMany({ where: { OR: [{ senderId: actor.id, receiverId: target.id },
    { senderId: target.id, receiverId: actor.id }] } });
  await prisma.recommendationItem.upsert({ where: { viewerId_targetUserId_recommendationDate: {
    viewerId: actor.id, targetUserId: target.id, recommendationDate: day } },
    create: { viewerId: actor.id, targetUserId: target.id, recommendationDate: day, sourceType: 'INITIAL', displayOrder: 1, reasonCode: 'TEST' }, update: {} });
  const accepted = await prisma.chatRequest.create({ data: { senderId: actor.id, receiverId: target.id,
    message: 'synthetic matrix fixture', sourceType: 'RECOMMENDATION', serviceDate: yesterday, status: 'ACCEPTED' } });
  const room = await prisma.chatRoom.create({ data: { chatRequestId: accepted.id,
    members: { create: [{ userId: actor.id }, { userId: target.id }] } } });
  const pending = await prisma.chatRequest.create({ data: { senderId: target.id, receiverId: actor.id,
    message: 'synthetic matrix fixture', sourceType: 'RECOMMENDATION', serviceDate: day } });
  const roomPath = `/chat-rooms/${room.id}`;
  assert.ok(await prisma.profileImage.count({ where: { userId: target.id, imageType: 'ORIGINAL_PRIVATE', generationStatus: 'DONE' } }));
  for (const a of states) for (const t of states) for (const direction of ['none', 'actor', 'target']) {
    result.contexts++;
    const label = `${a}/${t}/${direction}`;
    await prisma.user.update({ where: { id: actor.id }, data: { status: a } });
    await prisma.user.update({ where: { id: target.id }, data: { status: t } });
    await prisma.block.deleteMany({ where: pair });
    if (direction !== 'none') await prisma.block.create({ data: {
      blockerId: direction === 'actor' ? actor.id : target.id, targetUserId: direction === 'actor' ? target.id : actor.id } });
    await prisma.rateLimitCounter.deleteMany({});
    const unblocked = direction === 'none', auth = authenticated(a);
    await test(`${label}: recommendation visibility`, async () => {
      const r = await call('/recommendations/today', token); assert.equal(r.status, auth ? 200 : 403);
      if (auth) assert.equal(r.body.data.cards.some(card => card.userId === String(target.id)), unblocked && publicTarget(t));
    });
    await test(`${label}: card access`, async () => {
      assert.equal((await call(`/cards/${target.id}`, token)).status, auth && unblocked && publicTarget(t) ? 200 : 403);
    });
    await prisma.heart.deleteMany({ where: { senderId: actor.id, receiverId: target.id } });
    await test(`${label}: heart and write guard`, async () => {
      const allowed = auth && unblocked && publicTarget(t);
      assert.equal((await call(`/cards/${target.id}/hearts`, token, 'POST', {})).status, allowed ? 201 : 403);
      assert.equal(await prisma.heart.count({ where: { senderId: actor.id, receiverId: target.id } }), allowed ? 1 : 0);
    });
    await test(`${label}: chat request and write guard`, async () => {
      const allowed = senderAllowed(a) && unblocked && t === 'ACTIVE';
      assert.equal((await call('/chat-requests', token, 'POST', { targetUserId: String(target.id), message: 'synthetic matrix' })).status, allowed ? 201 : 403);
      assert.equal(await prisma.chatRequest.count({ where: { senderId: actor.id, receiverId: target.id, serviceDate: day } }), allowed ? 1 : 0);
    });
    await prisma.chatRequest.deleteMany({ where: { senderId: actor.id, receiverId: target.id, serviceDate: day } });
    await test(`${label}: accept and atomic write guard`, async () => {
      const allowed = senderAllowed(a) && unblocked && t === 'ACTIVE';
      assert.equal((await call(`/chat-requests/${pending.id}/accept`, token, 'POST', {})).status, allowed ? 201 : 403);
      const saved = await prisma.chatRequest.findUniqueOrThrow({ where: { id: pending.id } });
      assert.equal(saved.status, allowed ? 'ACCEPTED' : 'PENDING');
      const created = await prisma.chatRoom.findUnique({ where: { chatRequestId: pending.id }, include: { members: true } });
      assert.equal(created?.members.length ?? 0, allowed ? 2 : 0);
    });
    await prisma.chatRoom.deleteMany({ where: { chatRequestId: pending.id } });
    await prisma.chatRequest.update({ where: { id: pending.id }, data: { status: 'PENDING', respondedAt: null } });
    await prisma.chatMessage.deleteMany({ where: { roomId: room.id } });
    await test(`${label}: message and write guard`, async () => {
      const allowed = senderAllowed(a) && unblocked && authenticated(t);
      assert.equal((await call(`${roomPath}/messages`, token, 'POST', { body: 'synthetic matrix' })).status, allowed ? 201 : 403);
      assert.equal(await prisma.chatMessage.count({ where: { roomId: room.id } }), allowed ? 1 : 0);
    });
    await test(`${label}: original issuance and send flag`, async () => {
      const r = await call(roomPath, token); assert.equal(r.status, auth ? 200 : 403);
      if (!auth) return;
      const canRead = unblocked && authenticated(t);
      assert.equal(r.body.data.partner.originalImages.length > 0, canRead);
      assert.equal(r.body.data.canSendMessage, senderAllowed(a) && canRead);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      for (const photo of r.body.data.partner.originalImages) assert.equal(new URL(photo.url).searchParams.get('X-Amz-Expires'), '60');
    });
  }
  await prisma.user.updateMany({ where: { id: { in: [actor.id, target.id] } }, data: { status: 'ACTIVE' } });
  await prisma.block.deleteMany({ where: pair });
  await prisma.rateLimitCounter.deleteMany({});
  await test('profile injected userId cannot change another profile', async () => {
    const own = await prisma.userProfile.findUniqueOrThrow({ where: { userId: actor.id } });
    const before = await prisma.userProfile.findUniqueOrThrow({ where: { userId: target.id } });
    const { id: ignoredId, userId: ignoredUser, createdAt, updatedAt, profileCompletedAt, ...fields } = own;
    const r = await call('/me/profile', token, 'PUT', { ...fields, userId: String(target.id), displayName: 'matrix synthetic profile' });
    assert.equal(r.status, 200); assert.equal(String(r.body.data.userId), String(actor.id));
    assert.deepEqual(await prisma.userProfile.findUniqueOrThrow({ where: { userId: target.id } }), before);
    await prisma.userProfile.update({ where: { userId: actor.id }, data: { displayName: own.displayName } });
  });
  await test('preferences injected userId cannot change another preference', async () => {
    const own = await prisma.userPreference.findUniqueOrThrow({ where: { userId: actor.id } });
    const before = await prisma.userPreference.findUniqueOrThrow({ where: { userId: target.id } });
    const { id: ignoredId, userId: ignoredUser, createdAt, updatedAt, ...fields } = own;
    const r = await call('/me/preferences', token, 'PUT', { ...fields, userId: String(target.id) });
    assert.equal(r.status, 200); assert.equal(String(r.body.data.userId), String(actor.id));
    assert.deepEqual(await prisma.userPreference.findUniqueOrThrow({ where: { userId: target.id } }), before);
  });
  const outsider = await prisma.user.findUniqueOrThrow({ where: { email: 'user5@kkagung.local' } });
  for (const [role, asToken] of [['outsider', issueAccessToken(outsider)], ['nonmember admin', adminToken]]) {
    for (const path of [roomPath, `${roomPath}/messages`]) await test(`${role}: ${path.replace(String(room.id), ':roomId')} denied`, async () => {
      assert.equal((await call(path, asToken)).status, 403);
    });
    await test(`${role}: message injection denied without write`, async () => {
      const before = await prisma.chatMessage.count({ where: { roomId: room.id } });
      assert.equal((await call(`${roomPath}/messages`, asToken, 'POST', { body: 'synthetic forbidden' })).status, 403);
      assert.equal(await prisma.chatMessage.count({ where: { roomId: room.id } }), before);
    });
    await test(`${role}: another receiver request acceptance denied`, async () => {
      // API specification: FORBIDDEN 403 for an existing request's non-receiver.
      const denied = await call(`/chat-requests/${pending.id}/accept`, asToken, 'POST', {});
      assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'FORBIDDEN');
      assert.equal((await prisma.chatRequest.findUniqueOrThrow({ where: { id: pending.id } })).status, 'PENDING');
      assert.equal(await prisma.chatRoom.count({ where: { chatRequestId: pending.id } }), 0);
    });
  }
  for (const role of ['USER', 'ADMIN']) for (const status of states) {
    await prisma.user.update({ where: { id: admin.id }, data: { role, status } });
    await test(`admin current DB ${role}/${status}, previously issued ADMIN token`, async () => {
      assert.equal((await call('/admin/settings', adminToken)).status, role === 'ADMIN' && status === 'ACTIVE' ? 200 : 403);
    });
  }
} catch (error) { result.failed.push({ name: 'fixture setup or unexpected error', kind: error.code ?? error.name }); }
finally {
  if (actor && target) await prisma.user.updateMany({ where: { id: { in: [actor.id, target.id] } }, data: { status: 'ACTIVE' } });
  if (admin) await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN', status: 'ACTIVE' } });
  await new Promise(done => server.close(done)); await prisma.$disconnect();
  writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
}
console.log(`Authorization matrix: ${result.contexts} contexts, ${result.passed.length} passed, ${result.failed.length} failed`);
process.exitCode = result.failed.length ? 1 : 0;
