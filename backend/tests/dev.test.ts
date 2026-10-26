import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

// app.ts 는 불러오는 시점에 ENABLE_TEST_ACCOUNTS 를 읽는다. 그래서 케이스마다
// 환경변수를 먼저 정하고 모듈을 새로 불러온다. 시드 계정은 읽기만 하며 추가·수정·삭제하지 않는다.
const SEED_DOMAIN = "@kkagung.local";
const DEMO_EMAIL = `demo${SEED_DOMAIN}`;
const SUSPENDED_EMAIL = `suspended${SEED_DOMAIN}`;
const UNKNOWN_ACCOUNT_ID = 99999;
// 자동 증가 ID 는 개발 DB 마다 다르다. 시드가 보장하는 것은 이메일이므로 ID 는 응답에서 찾는다.
const SEED_EMAILS = ["admin", "demo", "user1", "user2", "user3", "user4", "user5", "user6", "suspended"]
  .map((name) => `${name}${SEED_DOMAIN}`);

type Env = { enabled: boolean; nodeEnv?: string };

let server: Server | null = null;
const clients: { $disconnect: () => Promise<void> }[] = [];

const start = async ({ enabled, nodeEnv }: Env) => {
  process.env.ENABLE_TEST_ACCOUNTS = enabled ? "true" : "false";
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;

  vi.resetModules();
  const { app } = await import("../src/app.js");
  const { prisma } = await import("../src/prisma.js");
  clients.push(prisma);

  return new Promise<string>((resolve, reject) => {
    const started = app.listen(0, () => {
      const address = started.address();
      if (address === null || typeof address === "string") return reject(new Error("포트를 확인할 수 없습니다."));
      resolve(`http://127.0.0.1:${address.port}`);
    });
    started.on("error", reject);
    server = started;
  });
};

const call = async (baseUrl: string, path: string, method: "GET" | "POST" = "GET") => {
  const response = await fetch(`${baseUrl}${path}`, { method });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
};

const accountIdFor = async (baseUrl: string, email: string) => {
  const { body } = await call(baseUrl, "/api/v1/dev/test-accounts");
  const found = (body.data.accounts as { accountId: string; email: string }[]).find((account) => account.email === email);
  if (found === undefined) throw new Error(`시드 계정을 찾을 수 없습니다: ${email}`);
  return found.accountId;
};

afterEach(async () => {
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  while (clients.length > 0) await clients.pop()!.$disconnect();
  vi.unstubAllEnvs();
});

describe("GET /api/v1/dev/test-accounts", () => {
  it("스위치를 켜면 시드 계정을 모두 반환한다", async () => {
    const baseUrl = await start({ enabled: true });
    const { status, body } = await call(baseUrl, "/api/v1/dev/test-accounts");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const emails = (body.data.accounts as { email: string }[]).map((account) => account.email);
    for (const seed of SEED_EMAILS) expect(emails).toContain(seed);
    for (const account of body.data.accounts) expect(account.email.endsWith(SEED_DOMAIN)).toBe(true);
  });

  it("응답에 비밀번호 관련 필드가 전혀 없다", async () => {
    const baseUrl = await start({ enabled: true });
    const { status, text } = await call(baseUrl, "/api/v1/dev/test-accounts");

    expect(status).toBe(200);
    expect(text).not.toContain("password");
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("password_hash");
  });

  it("스위치를 끄면 404 RESOURCE_NOT_FOUND 를 반환한다", async () => {
    const baseUrl = await start({ enabled: false });
    const { status, body } = await call(baseUrl, "/api/v1/dev/test-accounts");

    expect(status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("스위치를 켜도 운영 환경이면 404 를 반환한다", async () => {
    const baseUrl = await start({ enabled: true, nodeEnv: "production" });
    const { status, body } = await call(baseUrl, "/api/v1/dev/test-accounts");

    expect(status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});

describe("POST /api/v1/dev/test-accounts/:accountId/token", () => {
  it("일반 시드 계정은 토큰을 발급한다", async () => {
    const baseUrl = await start({ enabled: true });
    const { status, body } = await call(baseUrl, `/api/v1/dev/test-accounts/${await accountIdFor(baseUrl, DEMO_EMAIL)}/token`, "POST");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // 토큰 값은 출력하지 않고 형태만 확인한다.
    expect(typeof body.data.token).toBe("string");
    expect(body.data.token.length).toBeGreaterThan(0);
    expect(body.data.user.email.endsWith(SEED_DOMAIN)).toBe(true);
  });

  it("정지된 계정은 403 SUSPENDED_USER 로 거절한다", async () => {
    const baseUrl = await start({ enabled: true });
    const { status, body } = await call(baseUrl, `/api/v1/dev/test-accounts/${await accountIdFor(baseUrl, SUSPENDED_EMAIL)}/token`, "POST");

    expect(status).toBe(403);
    expect(body.error.code).toBe("SUSPENDED_USER");
  });

  it("없는 계정은 404 RESOURCE_NOT_FOUND 로 거절한다", async () => {
    const baseUrl = await start({ enabled: true });
    const { status, body } = await call(baseUrl, `/api/v1/dev/test-accounts/${UNKNOWN_ACCOUNT_ID}/token`, "POST");

    expect(status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});
