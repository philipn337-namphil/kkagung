import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import jwt from '../../../backend/node_modules/jsonwebtoken/index.js';
import bcrypt from '../../../backend/node_modules/bcryptjs/index.js';

const fixture = vi.hoisted(() => {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.AUTH_JWT_ISSUER = 'kkagung-api';
  process.env.AUTH_JWT_AUDIENCE = 'kkagung-client';
  delete process.env.JWT_EXPIRES_IN;
  return { passwordHash: '' };
});
vi.mock('../../../backend/src/prisma.js', () => ({ prisma: {
  rateLimitCounter: { upsert: vi.fn(async () => ({ count: 1 })) },
  revokedAccessToken: { findUnique: vi.fn(async () => null) },
  user: {
  findUnique: vi.fn(async () => ({ id: 1n, role: 'USER', status: 'ACTIVE', adultVerifiedAt: new Date(), passwordHash: fixture.passwordHash })),
  update: vi.fn(async () => ({})),
  create: vi.fn(),
} } }));
import { app } from '../../../backend/src/app.js';
import { prisma } from '../../../backend/src/prisma.js';

let server: Server;
let base: string;
let token: string;
beforeAll(async () => {
  const password = crypto.randomUUID();
  fixture.passwordHash = await bcrypt.hash(password, 4);
  server = await new Promise<Server>(resolve => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const response = await fetch(base + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'production-test@example.invalid', password }),
  });
  expect(response.status).toBe(200);
  token = (await response.json()).data.token;
});
afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
it('production login actually issues a 900 second JWT', () => {
  const claims: any = jwt.decode(token);
  expect(claims.exp - claims.iat).toBe(900);
});
it('production-issued token passes real authentication middleware', async () => {
  expect((await fetch(base + '/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
});
it('production registration refuses client-only adult verification without creating a user', async () => {
  const response = await fetch(base + '/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'fixture@example.invalid', password: crypto.randomUUID(), adultVerified: true }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe('ADULT_VERIFICATION_REQUIRED');
  expect(prisma.user.create).not.toHaveBeenCalled();
});
