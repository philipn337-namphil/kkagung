import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 로그인 한도는 틀린 시도를 막기 위한 것이다. 성공한 로그인까지 세면 한 번도 틀리지 않은
// 사용자가 몇 번 만에 잠긴다. 실제로 데모 중에 그렇게 막혔다.
// IP 한도는 같은 출구를 쓰는 여러 사람을 함께 막으므로 여유를 두되, 여러 계정에 비밀번호를
// 뿌리는 공격을 막는 것은 이 한도뿐이라 크게 열지 않는다. 두 성질을 여기서 고정한다.
//
// 틀린 시도에는 없는 계정을 쓴다. 있는 계정은 bcrypt 비교까지 가서 한 번에 수백 ms 가 걸리고,
// 계정 바구니가 함께 차올라 어느 한도에 걸린 것인지 흐려진다.

const SEED_PASSWORD = "kkagung123!";
const DEMO = "demo@kkagung.local";
const IP_LIMIT = 20;
const ACCOUNT_LIMIT = 10;

let server: Server | null = null;
let baseUrl = "";
const clients: { $disconnect: () => Promise<void> }[] = [];

const start = async () => {
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

/** 케이스마다 다른 주소로 보내 IP 바구니를 나눈다. TRUST_PROXY 가 켜져 있어야 반영된다. */
const login = (email: string, password: string, address: string) =>
  fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": address },
    body: JSON.stringify({ email, password }),
  }).then((response) => response.status);

let seed = 0;
const freshAddress = () => `198.51.100.${(seed += 1) % 250}`;
const freshEmail = () => `no-such-${(seed += 1)}-${Date.now()}@kkagung.invalid`;

beforeEach(async () => {
  process.env.TRUST_PROXY = "1";
  baseUrl = await start();
  const { prisma } = await import("../src/prisma.js");
  // 앞선 파일이 남긴 카운터와 섞이지 않게 비운다. setup.ts 와 같은 이유다.
  await prisma.rateLimitCounter.deleteMany({});
});

afterEach(async () => {
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  while (clients.length > 0) await clients.pop()!.$disconnect();
});

describe("로그인 속도 제한", () => {
  it("맞게 들어온 로그인은 한도를 깎지 않는다", async () => {
    const address = freshAddress();
    // IP 한도를 넘는 횟수를 성공으로만 채운다. 세고 있었다면 중간에 429 가 나온다.
    for (let attempt = 0; attempt < IP_LIMIT + 5; attempt += 1) {
      expect(await login(DEMO, SEED_PASSWORD, address), `${attempt + 1}번째 로그인이 막혔다`).toBe(200);
    }
  }, 60_000);

  it("틀린 시도는 쌓여서 IP 한도에 걸린다", async () => {
    const address = freshAddress();
    // 계정마다 한 번씩만 쓴다. 계정 바구니는 차지 않으므로 걸리는 것은 IP 한도뿐이다.
    const seen: number[] = [];
    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      seen.push(await login(freshEmail(), "wrong-password", address));
    }
    expect(seen.slice(0, IP_LIMIT).every((status) => status === 401), "한도까지는 통과해야 한다").toBe(true);
    expect(seen.at(-1)).toBe(429);
  }, 60_000);

  it("한 계정을 집요하게 틀리면 IP 한도 전에 계정 한도가 먼저 막는다", async () => {
    const address = freshAddress();
    const email = freshEmail();
    const seen: number[] = [];
    for (let attempt = 0; attempt < ACCOUNT_LIMIT + 2; attempt += 1) {
      seen.push(await login(email, "wrong-password", address));
    }
    expect(seen.slice(0, ACCOUNT_LIMIT).every((status) => status === 401)).toBe(true);
    expect(seen.at(-1)).toBe(429);
  }, 60_000);

  it("한 계정이 막혀도 같은 IP 의 다른 계정은 들어올 수 있다", async () => {
    const address = freshAddress();
    const email = freshEmail();
    for (let attempt = 0; attempt < ACCOUNT_LIMIT + 1; attempt += 1) await login(email, "wrong-password", address);
    expect(await login(email, "wrong-password", address)).toBe(429);
    // 계정 바구니가 막힌 것이지 IP 바구니가 막힌 것이 아니다.
    expect(await login(DEMO, SEED_PASSWORD, address)).toBe(200);
  }, 60_000);
});
