import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
const { issueAccessToken } = await load('src/lib/accessToken.ts');
const { fortuneDateOf, serviceDateOf } = await load('src/lib/recommendation.ts');
const require = createRequire(resolve(backend, 'package.json'));
const sharp = require('sharp');
const result = { recordedAt: new Date().toISOString(), mode: 'real HTTP/MySQL, actual image processing, Moto S3 simulation',
  passed: [], failed: [], failureKinds: {}, observations: {}, cloudPolicyVerified: false, signatureExpiryVerified: false };
const test = async (name, fn) => { try { await fn(); result.passed.push(name); } catch (error) {
  result.failed.push(name); result.failureKinds[name] = error.code ?? error.name;
} };
const server = await new Promise(done => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (path, token, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
    ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), headers: response.headers };
};
let owner;
try {
  // Existing chat-room behavior is checked before this script changes fixture states.
  const rooms = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/chatRooms.test.ts',
    '--reporter=json', '--maxWorkers=1', '--hookTimeout=60000', '--testTimeout=60000'],
    { cwd: backend, env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const roomEvidence = { success: rooms.status === 0 && !rooms.error };
  try {
    const parsed = JSON.parse(rooms.stdout);
    Object.assign(roomEvidence, { passed: parsed.numPassedTests, failed: parsed.numFailedTests, pending: parsed.numPendingTests });
  } catch { roomEvidence.success = false; }
  writeFileSync(new URL('evidence/chat-room-regression.json', import.meta.url), JSON.stringify(roomEvidence, null, 2) + '\n');
  if (!roomEvidence.success) result.failed.push('existing chat-room regression');
  await prisma.rateLimitCounter.deleteMany({}); // Guarded, freshly created disposable DB only.
  owner = await prisma.user.findUniqueOrThrow({ where: { email: 'user1@kkagung.local' } });
  const peer = await prisma.user.findUniqueOrThrow({ where: { email: 'user4@kkagung.local' } });
  // An interrupted broad suite must not leave the dedicated scenario's baseline sanctioned.
  await prisma.user.updateMany({ where: { id: { in: [owner.id, peer.id] } }, data: { status: 'ACTIVE', withdrawnAt: null } });
  const token = issueAccessToken(owner), otherToken = issueAccessToken(owner), peerToken = issueAccessToken(peer);
  const bytes = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#c85' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const upload = (slot, asToken = token) => {
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/jpeg' }), '../../synthetic.jpg');
    form.append('slot', String(slot)); return call('/me/images', asToken, 'POST', form);
  };
  const uploaded = await upload(2); assert.equal(uploaded.status, 202);
  await test('oversized multipart just above 10 MiB returns 413 rather than a transport failure', async () => {
    const form = new FormData(); form.append('file', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], { type: 'image/jpeg' }), 'oversize.jpg');
    const response = await call('/me/images', token, 'POST', form);
    result.observations.oversizedMultipart = { status: response.status }; assert.equal(response.status, 413);
  });
  await test('compressed multipart above 20 million pixels returns 413', async () => {
    const data = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: '#a87' } }).png().toBuffer();
    const form = new FormData(); form.append('file', new Blob([data], { type: 'image/png' }), 'pixels.png');
    assert.equal((await call('/me/images', token, 'POST', form)).status, 413);
  });
  await test('owner gets normalized original through 60-second signed URL; stranger cannot delete it', async () => {
    const listing = await call('/me/images', token);
    const image = listing.body.data.images.find(row => row.slot === 2);
    assert.equal(image.publicType, 'BLURRED_PUBLIC');
    const row = await prisma.profileImage.findUniqueOrThrow({ where: { id: BigInt(uploaded.body.data.imageId) } });
    assert.ok(row.objectKey.startsWith(`originals/${owner.id}/`)); assert.equal(row.objectKey.includes('synthetic'), false);
    const signed = new URL(image.originalUrl); assert.equal(signed.searchParams.get('X-Amz-Expires'), '60');
    const stored = await fetch(image.originalUrl); assert.equal(stored.status, 200);
    const metadata = await sharp(Buffer.from(await stored.arrayBuffer())).metadata();
    assert.equal(metadata.exif, undefined); assert.equal(metadata.width, 20); assert.equal(metadata.height, 30);
    assert.equal((await call(`/me/images/${uploaded.body.data.imageId}`, peerToken, 'DELETE')).status, 404);
    const other = (await call('/me/images', peerToken)).body.data.images;
    assert.equal(other.some(row => String(row.imageId) === uploaded.body.data.imageId), false);
  });
  await test('concurrent uploads cannot exceed three photos or duplicate a slot [IMG-01]', async () => {
    const responses = await Promise.all([upload(3), upload(3)]);
    const count = await prisma.profileImage.count({ where: { userId: owner.id, imageType: 'ORIGINAL_PRIVATE' } });
    const slotCount = await prisma.profileImage.count({ where: { userId: owner.id, slot: 3, imageType: 'ORIGINAL_PRIVATE' } });
    const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const storage = new S3Client({ endpoint: process.env.OBJECT_STORAGE_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY } });
    const referenced = new Set((await prisma.profileImage.findMany({ where: { userId: owner.id }, select: { objectKey: true } })).map(row => row.objectKey));
    const orphanCounts = {};
    try {
      for (const [kind, bucket, prefix] of [['private', process.env.OBJECT_STORAGE_BUCKET_PRIVATE, `originals/${owner.id}/`],
        ['public', process.env.OBJECT_STORAGE_BUCKET_PUBLIC, `profiles/blur/${owner.id}/`]]) {
        const listed = await storage.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
        orphanCounts[kind] = (listed.Contents ?? []).filter(row => !referenced.has(row.Key)).length;
      }
    } finally { storage.destroy(); }
    result.observations.concurrentUploads = { statuses: responses.map(row => row.status), originalCount: count, slot3OriginalCount: slotCount, orphanCounts };
    assert.ok(responses.every(row => [202, 409].includes(row.status)));
    assert.equal(responses.filter(row => row.status === 202).length, 1); assert.ok(count <= 3); assert.equal(slotCount, 1);
    assert.equal(orphanCounts.private, 0); assert.equal(orphanCounts.public, 0);
  });
  const day = fortuneDateOf(serviceDateOf(new Date()));
  assert.equal((await call('/daily/open', peerToken, 'POST', {})).status, 200);
  await prisma.recommendationItem.upsert({ where: { viewerId_targetUserId_recommendationDate: { viewerId: peer.id, targetUserId: owner.id, recommendationDate: day } },
    create: { viewerId: peer.id, targetUserId: owner.id, recommendationDate: day, sourceType: 'INITIAL', displayOrder: 1, reasonCode: 'TEST' }, update: { sourceType: 'INITIAL' } });
  await prisma.heart.create({ data: { senderId: owner.id, receiverId: peer.id } });
  const request = await prisma.chatRequest.create({ data: { senderId: owner.id, receiverId: peer.id, message: 'synthetic fixture',
    sourceType: 'RECEIVED_HEART', serviceDate: day, status: 'ACCEPTED' } });
  const room = await prisma.chatRoom.create({ data: { chatRequestId: request.id,
    members: { create: [{ userId: owner.id }, { userId: peer.id }] } } });
  const roomPath = `/chat-rooms/${room.id}`;
  const peerPhoto = await upload(2, peerToken); assert.equal(peerPhoto.status, 202);
  await test('accepted room participants receive only each other original URLs with max 60-second expiry and no-store', async () => {
    for (const [asToken, photoId] of [[peerToken, uploaded.body.data.imageId], [token, peerPhoto.body.data.imageId]]) {
      const response = await call(roomPath, asToken); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const originals = response.body.data.partner.originalImages;
      assert.ok(originals.length > 0 && originals.length <= 3);
      const photo = originals.find(row => row.imageId === photoId); assert.ok(photo);
      assert.deepEqual(Object.keys(photo).sort(), ['expiresAt', 'imageId', 'url']);
      assert.equal(new URL(photo.url).searchParams.get('X-Amz-Expires'), '60');
      assert.ok(Date.parse(photo.expiresAt) - Date.now() <= 60000);
      const downloaded = await fetch(photo.url); assert.equal(downloaded.status, 200); await downloaded.arrayBuffer();
    }
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@kkagung.local' } });
    assert.equal((await call(roomPath, issueAccessToken(admin))).status, 403);
  });
  await test('pending, rejected and ignored request states cannot reveal originals even with stale room membership', async () => {
    try {
      for (const status of ['PENDING', 'REJECTED', 'IGNORED']) {
        await prisma.chatRequest.update({ where: { id: request.id }, data: { status } });
        assert.equal((await call(roomPath, peerToken)).status, 404);
      }
    } finally { await prisma.chatRequest.update({ where: { id: request.id }, data: { status: 'ACCEPTED' } }); }
  });
  await test('either block direction stops accepted-room original URL issuance', async () => {
    for (const byOwner of [true, false]) {
      const block = await prisma.block.create({ data: { blockerId: byOwner ? owner.id : peer.id, targetUserId: byOwner ? peer.id : owner.id } });
      try {
        for (const asToken of [token, peerToken]) {
          const response = await call(roomPath, asToken); assert.equal(response.status, 200);
          assert.deepEqual(response.body.data.partner.originalImages, []);
        }
      } finally { await prisma.block.delete({ where: { id: block.id } }); }
    }
  });
  await test('chat sending restriction does not revoke accepted-room photo read access', async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'CHAT_RESTRICTED' } });
    try {
      const response = await call(roomPath, token); assert.equal(response.status, 200);
      assert.equal(response.body.data.canSendMessage, false); assert.ok(response.body.data.partner.originalImages.length > 0);
    } finally { await prisma.user.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } }); }
  });
  const visible = async () => {
    const recs = await call('/recommendations/today', peerToken), hearts = await call('/hearts/received', peerToken), rooms = await call('/chat-rooms', peerToken);
    assert.equal(recs.status, 200); assert.equal(hearts.status, 200); assert.equal(rooms.status, 200);
    return {
      recommended: recs.body.data.cards.some(row => row.userId === String(owner.id)),
      heart: hearts.body.data.items.some(row => row.sender?.userId === String(owner.id)),
      room: rooms.body.data.items.some(row => row.roomId === String(room.id)),
    };
  };
  await test('active relationship baseline is visible and third party cannot read messages', async () => {
    assert.deepEqual(await visible(), { recommended: true, heart: true, room: true });
    assert.equal((await call(`${roomPath}/messages`, peerToken, 'POST', { body: 'synthetic baseline' })).status, 201);
    const third = await prisma.user.findUniqueOrThrow({ where: { email: 'user5@kkagung.local' } });
    assert.equal((await call(`${roomPath}/messages`, issueAccessToken(third))).status, 403);
  });
  for (const status of ['SUSPENDED', 'WITHDRAWN']) {
    await test(`${status}: old token denied; peer recommendations, hearts and rooms exclude account; new messages denied`, async () => {
      await prisma.user.update({ where: { id: owner.id }, data: { status } });
      try {
        for (const path of ['/me', '/me/images', '/me/images/status', '/recommendations/today', '/hearts/received', `${roomPath}/messages`])
          assert.equal((await call(path, otherToken)).status, 403);
        assert.equal((await upload(3)).status, 403);
        assert.deepEqual(await visible(), { recommended: false, heart: false, room: false });
        assert.equal((await call(`/cards/${owner.id}`, peerToken)).status, 403);
        assert.equal((await call(`/cards/${owner.id}/hearts`, peerToken, 'POST', {})).status, 403);
        assert.equal((await call('/chat-requests', peerToken, 'POST', { targetUserId: String(owner.id), message: 'must be rejected' })).status, 403);
        assert.equal((await call(`${roomPath}/messages`, peerToken, 'POST', { body: 'must be rejected' })).status, 403);
        const detail = await call(roomPath, peerToken); assert.equal(detail.status, 200);
        assert.deepEqual(detail.body.data.partner.originalImages, []); assert.equal(detail.body.data.canSendMessage, false);
      } finally { await prisma.user.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } }); }
    });
  }
  await test('real withdrawal revokes used token and blocks other token from new photo URL issuance', async () => {
    assert.equal((await call('/me', token, 'DELETE')).status, 200);
    assert.equal((await call('/me/images', token)).status, 401);
    assert.equal((await call('/me/images', otherToken)).status, 403);
    assert.deepEqual(await visible(), { recommended: false, heart: false, room: false });
    assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).withdrawnAt);
  });
} catch (error) { result.failed.push('fixture setup or unexpected error'); result.failureKinds.setup = error.code ?? error.name; }
finally {
  await new Promise(done => server.close(done)); await prisma.$disconnect();
  writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
}
console.log(`Image/state audit: ${result.passed.length} passed, ${result.failed.length} failed`);
process.exitCode = result.failed.length ? 1 : 0;
