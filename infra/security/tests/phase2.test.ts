import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from '../../../backend/node_modules/jsonwebtoken/index.js';
import bcrypt from '../../../backend/node_modules/bcryptjs/index.js';
import type { Server } from 'node:http';

// Test-only credentials are generated per run. No live DB, storage, API key or photo.
const fixture = vi.hoisted(() => {
  process.env.JWT_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.FRONTEND_URL = 'http://localhost:5173';
  return { user: {} as any, saved: null as any };
});
vi.mock('../../../backend/src/prisma.js', () => ({
  prisma: {
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
  it('logged-out token must not remain usable', async () => {
    const token = sign();
    expect((await request('/api/v1/auth/logout', token, {})).status).toBe(200);
    expect((await request('/api/v1/me', token)).status).toBe(401);
  });
  it('registration must not accept client-only adult verification', async () => {
    fixture.user = null;
    const response = await request('/api/v1/auth/register', undefined, { email: 'new@example.invalid', password, adultVerified: true });
    expect(response.status).toBe(403);
  });
  it('withdrawn account must not obtain a new login token', async () => {
    fixture.user.status = 'WITHDRAWN';
    expect((await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password })).status).toBe(403);
  });
  it('login token must respect 15 minute policy and required claims', async () => {
    const response = await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password });
    const claims: any = jwt.decode((await response.json()).data.token);
    // Only duration is compared: failing output never contains token values.
    expect(claims.exp - claims.iat).toBe(900);
    expect(Boolean(claims.iss && claims.aud && claims.jti)).toBe(true);
  });
  it('login failure bursts must eventually return 429 (50 local requests)', async () => {
    const statuses = [];
    for (let i = 0; i < 50; i++) statuses.push((await request('/api/v1/auth/login', undefined, { email: fixture.user.email, password: 'intentionally-wrong-test-input' })).status);
    expect(statuses.includes(429)).toBe(true);
  });
  it('general API bursts must eventually return 429 (100 local requests)', async () => {
    const statuses = [];
    const token = sign();
    for (let i = 0; i < 100; i++) statuses.push((await request('/api/v1/me', token)).status);
    expect(statuses.includes(429)).toBe(true);
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
  const invoke = (token: string) => {
    const result = { status: 0, continued: false };
    const req: any = { header: () => `Bearer ${token}` };
    const res: any = { status: (code: number) => { result.status = code; return res; }, json: () => res };
    requireAuth(req, res, () => requireAdmin(req, res, () => { result.continued = true; }));
    return result;
  };
  it('USER role is rejected with 403 by middleware', () => expect(invoke(sign()).status).toBe(403));
  it('revoked admin role must not trust stale ADMIN token', () => {
    fixture.user.role = 'USER';
    expect(invoke(sign({ role: 'ADMIN' })).continued).toBe(false);
  });
});

describe('Phase 2 integration gates: implementation/infrastructure required', () => {
  it.skip('real admin endpoint returns 403 for USER; current admin routes absent', () => {});
  it.skip('private original photo denied before acceptance and allowed only to participants', () => {});
  it.skip('blocked pair cannot create requests or send messages', () => {});
  it.skip('admin setting changes create durable before/after audit entries', () => {});
  it.skip('disguised extension, invalid MIME, oversize and excessive pixels rejected; EXIF removed', () => {});
  it.skip('recommendation/heart/chat ownership, sanction and withdrawal restrictions enforced', () => {});
  it.skip('isolated DB/object/NAS restore meets measured RPO and RTO', () => {});
});
