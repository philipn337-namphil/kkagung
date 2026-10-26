import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";

// 탈퇴는 계정 상태를 바꾸고 토큰을 폐기한다. 시드 계정을 쓰면 다른 테스트의 전제가 무너지므로
// 전용 계정을 만들어 쓰고 끝나면 지운다.
const LEAVER = "withdrawal-leaver@kkagung.test";
const PEER = "withdrawal-peer@kkagung.test";
const EMAILS = [LEAVER, PEER];

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let jwtIssuer = "";
let jwtAudience = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ role: "USER" }, jwtSecret, {
  subject: userId.toString(), expiresIn: "12h", issuer: jwtIssuer, audience: jwtAudience, jwtid: crypto.randomUUID(),
});

const call = async (path: string, options: { method?: string; token?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
};

const resetAccounts = async () => {
  await db.user.updateMany({
    where: { id: { in: Object.values(ids) } },
    data: { status: "ACTIVE", withdrawnAt: null },
  });
  await db.revokedAccessToken.deleteMany({ where: { userId: { in: Object.values(ids) } } });
};

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  const appConfig = (await import("../src/config.js")).config;
  jwtSecret = appConfig.jwtSecret; jwtIssuer = appConfig.jwtIssuer; jwtAudience = appConfig.jwtAudience;
  db = await loadPrisma();

  for (const email of EMAILS) {
    await db.user.upsert({
      where: { email },
      update: { status: "ACTIVE", withdrawnAt: null, adultVerifiedAt: new Date() },
      create: { email, passwordHash: "test-only-no-login", adultVerifiedAt: new Date() },
    });
  }
  const users = await db.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true, email: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  expect(Object.keys(ids)).toHaveLength(EMAILS.length);

  baseUrl = await new Promise<string>((resolve, reject) => {
    const started = app.listen(0, () => {
      const address = started.address();
      if (address === null || typeof address === "string") return reject(new Error("포트를 확인할 수 없습니다."));
      resolve(`http://127.0.0.1:${address.port}`);
    });
    started.on("error", reject);
    server = started;
  });
});

beforeEach(resetAccounts);

afterAll(async () => {
  await db.revokedAccessToken.deleteMany({ where: { userId: { in: Object.values(ids) } } });
  await db.user.deleteMany({ where: { email: { in: EMAILS } } });
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await db.$disconnect();
});

describe("DELETE /api/v1/me", () => {
  it("계정을 지우지 않고 상태만 WITHDRAWN 으로 바꾼다", async () => {
    const response = await call("/api/v1/me", { method: "DELETE", token: tokenFor(ids[LEAVER]) });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("WITHDRAWN");
    expect(response.body.data.withdrawnAt).toBeTruthy();

    const stored = await db.user.findUnique({ where: { id: ids[LEAVER] } });
    // 행이 남아 있어야 신고·채팅 기록의 참조가 끊기지 않는다.
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("WITHDRAWN");
    expect(stored!.withdrawnAt).toBeInstanceOf(Date);
  });

  it("탈퇴에 쓴 토큰은 더 쓸 수 없다", async () => {
    const token = tokenFor(ids[LEAVER]);
    expect((await call("/api/v1/me", { token })).status).toBe(200);

    expect((await call("/api/v1/me", { method: "DELETE", token })).status).toBe(200);

    const after = await call("/api/v1/me", { token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("UNAUTHORIZED");
  });

  it("탈퇴한 계정의 다른 토큰도 거부한다", async () => {
    await call("/api/v1/me", { method: "DELETE", token: tokenFor(ids[LEAVER]) });

    // 폐기 목록에 없는 새 토큰이어도 계정 상태로 막혀야 한다.
    const fresh = await call("/api/v1/me", { token: tokenFor(ids[LEAVER]) });
    expect(fresh.status).toBe(403);
    expect(fresh.body.error.code).toBe("FORBIDDEN");
  });

  it("탈퇴하면 추천 대상에서 빠진다", async () => {
    const before = await db.user.count({
      where: { id: ids[LEAVER], status: { in: ["ACTIVE", "CHAT_RESTRICTED"] } },
    });
    expect(before).toBe(1);

    await call("/api/v1/me", { method: "DELETE", token: tokenFor(ids[LEAVER]) });

    const after = await db.user.count({
      where: { id: ids[LEAVER], status: { in: ["ACTIVE", "CHAT_RESTRICTED"] } },
    });
    expect(after).toBe(0);
  });

  it("탈퇴한 계정의 사진은 더 조회되지 않는다", async () => {
    const token = tokenFor(ids[LEAVER]);
    await call("/api/v1/me", { method: "DELETE", token });

    // 새 토큰으로도 본인 사진 목록에 접근할 수 없다. 원본 서명 URL 이 더 발급되지 않는다는 뜻이다.
    const images = await call("/api/v1/me/images", { token: tokenFor(ids[LEAVER]) });
    expect(images.status).toBe(403);
  });

  it("로그인하지 않으면 401 이다", async () => {
    expect((await call("/api/v1/me", { method: "DELETE" })).status).toBe(401);
  });

  it("다른 사람의 계정은 영향을 받지 않는다", async () => {
    await call("/api/v1/me", { method: "DELETE", token: tokenFor(ids[LEAVER]) });

    const peer = await db.user.findUnique({ where: { id: ids[PEER] } });
    expect(peer!.status).toBe("ACTIVE");
    expect(peer!.withdrawnAt).toBeNull();
    expect((await call("/api/v1/me", { token: tokenFor(ids[PEER]) })).status).toBe(200);
  });
});
