import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from '../../../backend/node_modules/jsonwebtoken/index.js';
import bcrypt from '../../../backend/node_modules/bcryptjs/index.js';
import type { Server } from 'node:http';

// Test-only credentials are generated per run. No live DB, storage, API key or photo.
const fixture = vi.hoisted(() => {
  process.env.JWT_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.NODE_ENV = 'development';
  delete process.env.JWT_EXPIRES_IN;
  process.env.FRONTEND_URL = 'http://localhost:5173';
  return { user: {} as any, saved: null as any, revoked: new Map(), counters: new Map() };
});
vi.mock('../../../backend/src/prisma.js', () => ({
  prisma: {
    revokedAccessToken: {
      findUnique: vi.fn(async ({ where }) => fixture.revoked.get(where.tokenHash) ?? null),
      upsert: vi.fn(async ({ create }) => { fixture.revoked.set(create.tokenHash, create); return create; }),
    },
    rateLimitCounter: {
      upsert: vi.fn(async ({ create }) => {
        const key = create.keyHash + ':' + create.windowStart.toISOString();
        const count = (fixture.counters.get(key) ?? 0) + 1;
        fixture.counters.set(key, count);
        return { count };
      }),
    },
    user: {
      findUnique: vi.fn(async () => fixture.user),
      update: vi.fn(async () => fixture.user),
      create: vi.fn(async ({ data }) => ({ id: 2n, role: 'USER', ...data })),
    },
    userProfile: { upsert: vi.fn(async ({ create }) => { fixture.saved = create; return create; }) },
    userPreference: { upsert: vi.fn(async ({ create }) => create) },
    $queryRaw: vi.fn(async () => [{ value: 1 }]),
  },
}));
import { app } from '../../../backend/src/app.js';
import { requireAdmin, requireAuth } from '../../../backend/src/middleware/auth.js';
import { prisma } from '../../../backend/src/prisma.js';

let server: Server;
let base: string;
let password: string;
let passwordHash: string;
const sign = (extra: Record<string, unknown> = {}, options = {}) =>
  jwt.sign({ sub: '1', role: 'USER', iss: 'kkagung-api', aud: 'kkagung-client', jti: crypto.randomUUID(), ...extra }, process.env.JWT_SECRET!, { expiresIn: '15m', ...options });
const request = (path: string, token?: string, body?: unknown) => fetch(base + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  password = crypto.randomUUID();
  passwordHash = await bcrypt.hash(password, 4);
  server = await new Promise<Server>(resolve => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(() => {
  fixture.user = { id: 1n, email: 'test@example.invalid', role: 'USER', status: 'ACTIVE', adultVerifiedAt: new Date(), passwordHash };
  fixture.saved = null;
  fixture.revoked.clear(); fixture.counters.clear();
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe('existing authentication and profile routes (mock DB)', () => {
  it('missing token returns 401', async () => expect((await request('/api/v1/me')).status).toBe(401));
  it('expired token returns 401', async () => expect((await request('/api/v1/me', sign({}, { expiresIn: -1 }))).status).toBe(401));
  it('forged signature returns 401', async () => {
    const forged = jwt.sign({ sub: '1', role: 'ADMIN' }, crypto.randomUUID());
    expect((await request('/api/v1/me', forged)).status).toBe(401);
  });
  it('wrong issuer and audience must return 401', async () => {
    expect((await request('/api/v1/me', sign({ iss: 'untrusted', aud: 'another-service' }))).status).toBe(401);
  });
  it('HS512 must be rejected when only HS256 is allowed', async () => {
    expect((await request('/api/v1/me', sign({}, { algorithm: 'HS512' }))).status).toBe(401);
  });
  it('token without expiry must be rejected', async () => {
    const token = jwt.sign({ sub: '1', role: 'USER', iss: 'kkagung-api', aud: 'kkagung-client', jti: crypto.randomUUID() }, process.env.JWT_SECRET!);
    expect((await request('/api/v1/me', token)).status).toBe(401);
  });
  it('malformed token subject returns 401', async () => {
    expect((await request('/api/v1/me', sign({ sub: 'not-an-id' }))).status).toBe(401);
  });
  it('token without token ID returns 401', async () => {
    expect((await request('/api/v1/me', sign({ jti: undefined }))).status).toBe(401);
  });
  it('token without issued-at returns 401', async () => {
    expect((await request('/api/v1/me', sign({}, { noTimestamp: true }))).status).toBe(401);
  });
  it('future issued-at and overflowing subject return 401', async () => {
    expect((await request('/api/v1/me', sign({ iat: Math.floor(Date.now() / 1000) + 3600 }))).status).toBe(401);
    expect((await request('/api/v1/me', sign({ sub: '9223372036854775808' }))).status).toBe(401);
  });
  it('raw token without Bearer scheme returns 401', async () => {
    const response = await fetch(base + '/api/v1/me', { headers: { Authorization: sign() } });
    expect(response.status).toBe(401);
  });
  it('deleted account returns 401 despite valid token', async () => {
    fixture.user = null;
    expect((await request('/api/v1/me', sign())).status).toBe(401);
  });
  it('valid token accesses own profile', async () => {
    const response = await request('/api/v1/me', sign());
    expect(response.status).toBe(200);
    expect((await response.json()).data.id).toBe('1');
  });
  it.each(['SUSPENDED', 'WITHDRAWN'])('existing token of %s account must be rejected', async status => {
    fixture.user.status = status;
    expect((await request('/api/v1/me', sign())).status).toBe(403);
  });
  it('unverified account must be rejected', async () => {
    fixture.user.adultVerifiedAt = null;
    expect((await request('/api/v1/me', sign())).status).toBe(403);
  });
  it.each(['RECOMMENDATION_BLOCKED', 'CHAT_RESTRICTED'])('limited USER status %s does not prohibit all authenticated APIs', async status => {
    fixture.user.status = status;
    expect((await request('/api/v1/me', sign())).status).toBe(200);
  });
  it('logged-out token must not remain usable', async () => {
    const token = sign();
    expect((await request('/api/v1/auth/logout', token, {})).status).toBe(200);
    expect((await request('/api/v1/me', token)).status).toBe(401);
  });
  it('development-only registration retains fixture support (production gate tested separately)', async () => {
    fixture.user = null;
    const response = await request('/api/v1/auth/register', undefined, { email: 'new@example.invalid', password, adultVerified: true });
    expect(response.status).toBe(201);
  });
  it('withdrawn account must not obtain a new login token', async () => {
    fixture.user.status = 'WITHDRAWN';
    expect((await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password })).status).toBe(403);
  });
  it('D-03 development login token uses 12 hour TTL', async () => {
    const response = await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password });
    const claims: any = jwt.decode((await response.json()).data.token);
    // Only duration is compared: failing output never contains token values.
    expect(claims.exp - claims.iat).toBe(43200);
  });
  it('login token contains issuer audience and token ID', async () => {
    const response = await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password });
    const claims: any = jwt.decode((await response.json()).data.token);
    expect(Boolean(claims.iss && claims.aud && claims.jti)).toBe(true);
  });
  it('suspended account login is rejected', async () => {
    fixture.user.status = 'SUSPENDED';
    expect((await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password })).status).toBe(403);
  });
  it('unverified account login is rejected', async () => {
    fixture.user.adultVerifiedAt = null;
    expect((await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password })).status).toBe(403);
  });
  it('login failure bursts must eventually return 429 (50 local requests)', async () => {
    const statuses = [];
    for (let i = 0; i < 50; i++) statuses.push((await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password: 'intentionally-wrong-test-input' })).status);
    expect(statuses.slice(0, 10).every(status => status === 401)).toBe(true);
    expect(statuses.slice(10).every(status => status === 429)).toBe(true);
  });
  it('general API bursts must eventually return 429 (100 local requests)', async () => {
    const statuses = [];
    const token = sign();
    for (let i = 0; i < 100; i++) statuses.push((await request('/api/v1/me', token)).status);
    expect(statuses.slice(0, 90).every(status => status === 200)).toBe(true);
    expect(statuses.slice(90).every(status => status === 429)).toBe(true);
  });
  it('forwarded address headers cannot evade the direct-IP login quota', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const result = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${i + 1}`,
      }, body: JSON.stringify({ email: `fixture${i}@example.invalid`, password: 'wrong-fixture' }) });
      statuses.push(result.status);
      if (result.status === 429) expect(Number(result.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
  it('rate store failure refuses the request without a bypass', async () => {
    vi.mocked(prisma.rateLimitCounter.upsert).mockRejectedValueOnce(new Error('Synthetic storage failure'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await request('/api/v1/me', sign())).status).toBe(500); }
    finally { spy.mockRestore(); }
  });
  it('revocation storage failure refuses logout and leaves no false success', async () => {
    vi.mocked(prisma.revokedAccessToken.upsert).mockRejectedValueOnce(new Error('Synthetic revocation failure'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await request('/api/v1/auth/logout', sign(), {})).status).toBe(500); }
    finally { spy.mockRestore(); }
  });
  it('logout revokes only the submitted token and persists a digest', async () => {
    const token = sign(); const other = sign();
    expect((await request('/api/v1/auth/logout', token, {})).status).toBe(200);
    expect((await request('/api/v1/me', token)).status).toBe(401);
    expect((await request('/api/v1/me', other)).status).toBe(200);
    const stored = [...fixture.revoked.values()][0];
    expect(/^[a-f0-9]{64}$/.test(stored.tokenHash)).toBe(true);
    expect(JSON.stringify(stored, (_, value) => typeof value === 'bigint' ? String(value) : value).includes(token)).toBe(false);
  });
  it('own profile writes must not follow a caller-supplied userId', async () => {
    const response = await fetch(base + '/api/v1/me/profile', {
      method: 'PUT', headers: { Authorization: `Bearer ${sign()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: '999', displayName: 'Test', birthDate: '2000-01-01', gender: 'MALE', regionCode: 'SEOUL_DONGDAEMUN', heightCm: 175, jobCategory: 'STUDENT', mbti: 'INTJ' }),
    });
    expect(response.status).toBe(200);
    expect(fixture.saved.userId).toBe(1n);
  });
  it('error logging must redact sensitive values', async () => {
    const markers = ['PASSWORD_TEST_MARKER', 'JWT_TEST_MARKER', 'PHOTO_URL_TEST_MARKER', 'CHAT_TEST_MARKER'];
    // Inject a synthetic upstream error: verifies redaction capability, not an actual leak.
    const captured: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { captured.push(args); });
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(new Error(markers.join('|')));
    try {
      expect((await request('/api/v1/me', sign())).status).toBe(500);
      const serialized = captured.flat().map(value => value instanceof Error ? value.message : String(value)).join(' ');
      expect(markers.some(marker => serialized.includes(marker))).toBe(false);
    } finally { spy.mockRestore(); }
  });
});

describe('admin middleware in isolation (not an implemented admin API)', () => {
  const invoke = async (token: string) => {
    const result = { status: 0, continued: false };
    const req: any = { header: () => `Bearer ${token}` };
    const res: any = { status: (code: number) => { result.status = code; return res; }, json: () => res };
    await requireAuth(req, res, () => requireAdmin(req, res, () => { result.continued = true; }));
    return result;
  };
  it('USER role is rejected with 403 by middleware', async () => expect((await invoke(sign())).status).toBe(403));
  it('revoked admin role must not trust stale ADMIN token', async () => {
    fixture.user.role = 'USER';
    expect((await invoke(sign({ role: 'ADMIN' }))).continued).toBe(false);
  });
  it('current DB admin role overrides stale USER role', async () => {
    fixture.user.role = 'ADMIN';
    expect((await invoke(sign())).continued).toBe(true);
  });
  it('suspended admin cannot pass middleware', async () => {
    fixture.user.role = 'ADMIN';
    fixture.user.status = 'SUSPENDED';
    expect((await invoke(sign({ role: 'ADMIN' }))).status).toBe(403);
  });
  it('non-active admin cannot pass middleware', async () => {
    fixture.user.role = 'ADMIN';
    fixture.user.status = 'CHAT_RESTRICTED';
    expect((await invoke(sign({ role: 'ADMIN' }))).status).toBe(403);
  });
});

describe('Phase 2 integration gates: implementation/infrastructure required', () => {
  it('merged real admin endpoint returns 403 for USER', async () => {
    const response = await fetch(base + '/api/v1/admin/settings/badge', {
      method: 'PUT', headers: { Authorization: `Bearer ${sign({ role: 'ADMIN' })}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ popularMinUniqueHearts: 11, popularMinUniqueChatRequests: 6 }),
    });
    expect(response.status).toBe(403);
  });
  it.skip('private original photo denied before acceptance and allowed only to participants', () => {});
  // These two gates execute against real MySQL in live-db-audit.mjs via portable-db-drill.mjs:
  // blocked pairs cannot create/accept requests or send messages; durable before/after admin audit.
  it.skip('disguised extension, invalid MIME, oversize and excessive pixels rejected; EXIF removed', () => {});
  it.skip('recommendation/heart/chat ownership, sanction and withdrawal restrictions enforced', () => {});
  it.skip('isolated DB/object/NAS restore meets measured RPO and RTO', () => {});
});
