import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const backend = resolve(process.argv[2] ?? '.'), root = resolve(backend, '..');
const runId = process.env.SECURITY_DB_RUN_ID, db = new URL(process.env.DATABASE_URL ?? 'file:///missing');
if (!/^[a-f0-9]{16}$/.test(runId ?? '') || db.protocol !== 'mysql:' || db.hostname !== '127.0.0.1' ||
    db.pathname !== `/kkagung_security_${runId}` || db.username !== 'kkagung_drill') {
  console.error('Refusing a database not created by the isolated runner'); process.exit(2);
}
// Random-port browser origin, disposable test process only; never persisted/deployed.
process.env.FRONTEND_URL = '*';
const load = file => import(pathToFileURL(resolve(backend, file)).href);
const { app } = await load('src/app.ts');
const { prisma } = await load('src/prisma.ts');
const { fortuneDateOf, serviceDateOf } = await load('src/lib/recommendation.ts');
const require = createRequire(resolve(backend, 'package.json'));
const result = { recordedAt: new Date().toISOString(), mode: 'unchanged frontend API client/renderers in VM with minimal DOM; real HTTP/MySQL/Sharp/Moto',
  browserRenderingVerified: false, passed: [], failed: [], observations: {}, cloudVerified: false };
const test = async (name, fn, owner = 'security') => { try { await fn(); result.passed.push(name); } catch (error) {
  result.failed.push({ name, owner, kind: error.code ?? error.name,
    ...(['number', 'boolean'].includes(typeof error.actual) ? { actual: error.actual } : {}),
    ...(['number', 'boolean'].includes(typeof error.expected) ? { expected: error.expected } : {}) });
} };
const server = await new Promise(done => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
const apiBase = `http://127.0.0.1:${server.address().port}`;
const source = readFileSync(resolve(root, 'frontend/app.js'), 'utf8');
const traffic = [];
class Element {
  innerHTML = ''; textContent = ''; className = ''; disabled = false; listeners = {}; classList = { toggle() {} };
  querySelector() { return null; } querySelectorAll() { return []; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  insertAdjacentHTML(_position, html) { this.innerHTML += html; }
}
const client = () => {
  const elements = new Map([['#app', new Element()], ['#toast', new Element()]]), storage = new Map();
  const sandbox = { window: { API_BASE_URL: apiBase, addEventListener() {}, scrollTo() {} },
    location: { hash: '#/' }, document: { querySelector: selector => elements.get(selector) ?? null, querySelectorAll: () => [] },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => {
      try { const response = await fetch(url, options); traffic.push({ path: new URL(url).pathname, status: response.status }); return response; }
      catch (error) { traffic.push({ path: new URL(url).pathname, status: 0 }); throw error; }
    },
    FormData, console: { log() {}, error() {} } };
  const context = vm.createContext(sandbox); vm.runInContext(source, context);
  return { context, elements, storage, sandbox, api: vm.runInContext('api', context), state: vm.runInContext('state', context),
    invoke: (name, ...args) => vm.runInContext(name, context)(...args),
    nodes: (...names) => names.forEach(name => elements.set(name, new Element())) };
};
let frontendServer;
try {
  const a = await prisma.user.findUniqueOrThrow({ where: { email: 'demo@kkagung.local' } });
  const b = await prisma.user.findUniqueOrThrow({ where: { email: 'user4@kkagung.local' } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@kkagung.local' } });
  await prisma.user.updateMany({ where: { id: { in: [a.id, b.id, admin.id] } }, data: { status: 'ACTIVE', withdrawnAt: null } });
  const pair = { OR: [{ blockerId: a.id, targetUserId: b.id }, { blockerId: b.id, targetUserId: a.id }] };
  await prisma.block.deleteMany({ where: pair });
  await prisma.chatRequest.deleteMany({ where: { OR: [{ senderId: a.id, receiverId: b.id }, { senderId: b.id, receiverId: a.id }] } });
  await prisma.heart.deleteMany({ where: { OR: [{ senderId: a.id, receiverId: b.id }, { senderId: b.id, receiverId: a.id }] } });
  await prisma.rateLimitCounter.deleteMany({});
  const alice = client(), bob = client(), operator = client();
  const login = async (c, user) => { const response = await c.api.testLogin(String(user.id)); c.invoke('completeLogin', response); await c.invoke('loadMe'); };
  await test('real seed-account login and me through frontend client', async () => {
    await login(alice, a); await login(bob, b); await login(operator, admin);
    assert.equal(String(alice.state.user.id), String(a.id)); assert.equal(operator.state.user.role, 'ADMIN');
    assert.ok(alice.storage.get('kkagung.access-token')); assert.ok(!alice.state.token.startsWith('mock-'));
  });
  await test('daily and recommendations render from real API', async () => {
    alice.nodes('#daily-area', '#recommendations', '#card-count', '#refresh-button');
    await alice.invoke('loadHome'); await bob.api.openDaily();
    assert.ok(alice.state.daily?.serviceDate); assert.ok(alice.elements.get('#daily-area').innerHTML.includes('새로고침권'));
    assert.ok(alice.state.cards.length > 0);
  });
  const day = fortuneDateOf(serviceDateOf(new Date()));
  await prisma.recommendationItem.upsert({ where: { viewerId_targetUserId_recommendationDate: {
    viewerId: a.id, targetUserId: b.id, recommendationDate: day } }, create: { viewerId: a.id, targetUserId: b.id,
    recommendationDate: day, sourceType: 'INITIAL', displayOrder: 1, reasonCode: 'TEST' }, update: {} });
  await test('heart created and received through frontend client', async () => {
    await alice.api.heart(String(b.id));
    assert.ok((await bob.api.receivedHearts()).items.some(row => row.sender.userId === String(a.id)));
    assert.equal(await prisma.heart.count({ where: { senderId: a.id, receiverId: b.id, canceledAt: null } }), 1);
  });
  await test('duplicate heart returns actual 409 without a second DB row or mock success', async () => {
    await assert.rejects(() => alice.api.heart(String(b.id)), error => error.status === 409);
    assert.equal(await prisma.heart.count({ where: { senderId: a.id, receiverId: b.id } }), 1);
  });
  await test('report is persisted through frontend API client', async () => {
    const report = await alice.api.report({ targetType: 'USER', targetId: String(b.id), reasonCode: 'OTHER', detail: 'synthetic integration report' });
    assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: BigInt(report.reportId) } })).reporterId, a.id);
  });
  await test('refresh ticket consumes through frontend client and rejects a second use', async () => {
    // Initial recommendations already cover all three active female seed accounts.
    // Introduce a previously suspended synthetic candidate after that snapshot.
    await prisma.user.update({ where: { email: 'suspended@kkagung.local' }, data: { status: 'ACTIVE' } });
    const refreshed = await alice.api.refresh(); assert.ok(Array.isArray(refreshed.cards)); assert.ok(refreshed.cards.length > 0);
    result.observations.refresh = { cardCount: refreshed.cards.length, ticketStatus: refreshed.refreshTicket?.status };
    await assert.rejects(() => alice.api.refresh(), error => error.status === 409);
  });
  const request = await alice.api.sendChatRequest(String(b.id), 'synthetic integration request');
  let roomId;
  await test('received request accepts into a real room through frontend client', async () => {
    assert.ok((await bob.api.chatRequests('received')).items.some(row => row.requestId === request.requestId));
    const response = await bob.api.resolveRequest(request.requestId, 'accept'); roomId = response.roomId;
    assert.ok(roomId); assert.equal(await prisma.chatRoomMember.count({ where: { roomId: BigInt(roomId) } }), 2);
    assert.ok((await alice.api.rooms()).items.some(row => row.roomId === roomId));
  });
  assert.ok(roomId);
  await test('reverse request rejection through frontend client creates no second room', async () => {
    const reverse = await bob.api.sendChatRequest(String(a.id), 'synthetic reverse request');
    await alice.api.resolveRequest(reverse.requestId, 'reject');
    assert.equal((await prisma.chatRequest.findUniqueOrThrow({ where: { id: BigInt(reverse.requestId) } })).status, 'REJECTED');
    assert.equal(await prisma.chatRoom.count({ where: { chatRequestId: BigInt(reverse.requestId) } }), 0);
  });
  const marker = '<img src=x onerror=alert(1)> synthetic message';
  await test('message roundtrip and XSS escaping with actual API response', async () => {
    const sent = await alice.api.sendMessage(roomId, marker); assert.equal(sent.body, marker);
    bob.nodes('#chat-header', '#messages', '#message-form', '#block-user');
    await bob.invoke('loadRoom', roomId);
    const html = bob.elements.get('#messages').innerHTML;
    assert.ok(html.includes('&lt;img')); assert.equal(html.includes(marker), false);
    assert.ok((await bob.api.messages(roomId)).items.some(row => row.body === marker));
  });
  const sharp = require('sharp');
  const bytes = await sharp({ create: { width: 20, height: 16, channels: 3, background: '#a85' } }).jpeg().toBuffer();
  const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'synthetic.jpg'); form.append('slot', '2');
  const upload = await fetch(`${apiBase}/api/v1/me/images`, { method: 'POST', headers: { Authorization: `Bearer ${bob.state.token}` }, body: form });
  assert.equal(upload.status, 202); await upload.json();
  await test('public card omits original object keys and signed original URLs', async () => {
    const detail = await vm.runInContext('request', alice.context)(`/cards/${b.id}`);
    const json = JSON.stringify(detail), html = alice.invoke('card', detail.card ?? detail);
    assert.equal(/originals\/|X-Amz-Signature|originalImages/.test(json), false);
    assert.equal(/originals\/|X-Amz-Signature/.test(html), false);
  });
  await test('accepted-room original URLs reach the actual storage fixture', async () => {
    const detail = await alice.api.room(roomId);
    const photo = await prisma.profileImage.findFirstOrThrow({ where: { userId: b.id, slot: 2, imageType: 'ORIGINAL_PRIVATE' } });
    const image = detail.partner.originalImages.find(row => row.imageId === String(photo.id));
    assert.ok(image); const response = await fetch(image.url); assert.equal(response.status, 200); await response.arrayBuffer();
  });
  await test('accepted-room frontend visibly renders authorized original image', async () => {
    alice.nodes('#chat-header', '#messages', '#message-form', '#block-user'); await alice.invoke('loadRoom', roomId);
    assert.ok(alice.elements.get('#chat-header').innerHTML.includes('<img'));
  }, 'frontend');
  await test('image status renderer recognizes DONE publicUrl from real response', async () => {
    const response = await bob.api.imageStatus(); assert.ok(response.items.some(row => row.status === 'DONE' && row.publicUrl));
    bob.nodes('#image-status'); await bob.invoke('loadImageStatus');
    assert.ok(bob.elements.get('#image-status').innerHTML.includes('공개 이미지 준비 완료'));
  }, 'frontend');
  await test('admin dashboard maps actual count response into metric values', async () => {
    const dashboard = await operator.api.admin('dashboard'); result.observations.adminTopLevelFields = Object.keys(dashboard).sort();
    operator.nodes('#admin-dashboard', '#admin-users', '#admin-reports', '#admin-settings'); await operator.invoke('loadAdmin');
    assert.equal(operator.elements.get('#admin-dashboard').innerHTML.includes('<b>-</b>'), false);
  }, 'frontend');
  await test('USER admin API forbidden without mock substitution', async () => {
    await assert.rejects(() => alice.api.admin('dashboard'), error => error.status === 403);
  });
  await test('chat restriction disables frontend send form', async () => {
    await prisma.user.update({ where: { id: a.id }, data: { status: 'CHAT_RESTRICTED' } });
    try {
      const detail = await alice.api.room(roomId); assert.equal(detail.canSendMessage, false);
      await alice.invoke('loadRoom', roomId);
      assert.equal(alice.elements.get('#message-form').disabled === true || alice.elements.get('#message-form').innerHTML.includes('disabled'), true);
    } finally { await prisma.user.update({ where: { id: a.id }, data: { status: 'ACTIVE' } }); }
  }, 'frontend');
  await test('block denies fresh message and photo URL; DB receives no new message', async () => {
    await alice.api.block(String(b.id)); const before = await prisma.chatMessage.count();
    await assert.rejects(() => bob.api.sendMessage(roomId, 'synthetic forbidden'), error => error.status === 403);
    assert.equal(await prisma.chatMessage.count(), before); assert.equal((await alice.api.room(roomId)).partner.originalImages.length, 0);
  });
  await test('logout revokes token on real backend', async () => {
    const token = alice.state.token; await alice.api.logout();
    const response = await fetch(`${apiBase}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401); await response.json();
  });
  await login(alice, a);
  await test('logout clears previous user recommendations and mock interaction cache', async () => {
    alice.nodes('#logout'); alice.invoke('bind', '/');
    alice.state.mock.hearts.add('synthetic-old-user');
    await alice.elements.get('#logout').listeners.click();
    assert.equal(alice.state.token, null); assert.equal(alice.storage.size, 0);
    assert.equal(alice.state.cards.length, 0); assert.equal(alice.state.daily, null); assert.equal(alice.state.mock.hearts.size, 0);
  }, 'frontend');
  await test('actual API rate limit returns 429 to frontend without mock success', async () => {
    await prisma.rateLimitCounter.deleteMany({});
    let throttled = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await bob.api.rooms(); } catch (error) { assert.equal(error.status, 429); throttled = true; break; }
    }
    assert.ok(throttled); await prisma.rateLimitCounter.deleteMany({});
  });
  result.observations.liveRequests = traffic.length;
  result.observations.mockEligibleLiveResponses = traffic.filter(row => row.status === 0 || row.status === 501).length;
  await test('functional integration never receives mock-eligible network errors or 501', async () => assert.equal(result.observations.mockEligibleLiveResponses, 0));
  for (const status of [401, 403, 404, 409, 429]) await test(`HTTP ${status} stays an error and never becomes mock data`, async () => {
    const c = client(); c.sandbox.fetch = async () => ({ ok: false, status, json: async () => ({ success: false, error: { code: 'SYNTHETIC_ERROR', message: 'synthetic' } }) });
    await assert.rejects(() => c.api.rooms(), error => error.status === status);
    const node = new Element(); c.invoke('renderError', { status, code: 'SYNTHETIC_ERROR' }, node); assert.ok(node.innerHTML.includes(String(status)));
  });
  await test('501 fallback after live success is explicitly labeled mock', async () => {
    const c = client(); c.state.source = 'api';
    c.sandbox.fetch = async () => ({ ok: false, status: 501, json: async () => ({ success: false }) });
    await c.api.rooms(); assert.ok(c.invoke('layout', 'synthetic page').includes('목업 데이터'));
  }, 'frontend');
  // The original server handler and source are served unchanged, except for a random loopback bind.
  const frontendRequire = createRequire(resolve(root, 'frontend/server.js'));
  let ready;
  vm.runInNewContext(readFileSync(resolve(root, 'frontend/server.js'), 'utf8'), { __dirname: resolve(root, 'frontend'),
    process: { env: { PORT: '0', API_BASE_URL: apiBase } }, console: { log() {} },
    require: name => name === 'http' ? { createServer: handler => ({ listen: (_port, cb) => {
      frontendServer = createServer(handler); ready = new Promise(done => frontendServer.listen(0, '127.0.0.1', () => { cb(); done(); }));
    } }) } : frontendRequire(name) });
  await ready;
  const frontendBase = `http://127.0.0.1:${frontendServer.address().port}`;
  await test('actual frontend handler serves only public assets and correct API configuration', async () => {
    const config = await (await fetch(frontendBase + '/config.js')).text(); assert.ok(config.includes(apiBase));
    for (const path of ['/.env', '/server.js', '/package.json']) { const response = await fetch(frontendBase + path); assert.equal(response.status, 404); await response.arrayBuffer(); }
  });
  await prisma.block.deleteMany({ where: pair }); await prisma.rateLimitCounter.deleteMany({});
  if (process.env.SECURITY_BROWSER_REVIEW === '1') {
    const sessionFile = resolve(root, '../.local-tools/frontend-review-session.json');
    const stopFile = resolve(root, `../.local-tools/frontend-review-${runId}.stop`);
    writeFileSync(sessionFile, JSON.stringify({ runId, frontendBase, roomId, stopFile, syntheticOnly: true, expiresInSeconds: 600 }, null, 2));
    console.log('Frontend browser fixture ready; waiting for explicit local stop marker (max 600 seconds)');
    const until = Date.now() + 600000;
    while (!existsSync(stopFile) && Date.now() < until) await new Promise(done => setTimeout(done, 1000));
    result.observations.browserStopMarkerReceived = existsSync(stopFile);
  }
} catch (error) { result.failed.push({ name: 'fixture setup or unexpected error', owner: 'security', kind: error.code ?? error.name }); }
finally {
  if (frontendServer) await new Promise(done => frontendServer.close(done));
  await new Promise(done => server.close(done)); await prisma.$disconnect();
  writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
}
console.log(`Frontend actual API audit: ${result.passed.length} passed, ${result.failed.length} failed`);
process.exitCode = result.failed.length ? 1 : 0;
