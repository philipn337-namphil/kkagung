import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local"];

// KST 2026-12-03 09:00 = UTC 2026-12-03T00:00Z → 서비스 날짜 2026-12-03
const FROZEN_UTC = "2026-12-03T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-12-03T00:00:00Z");

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ sub: userId.toString(), role: "USER" }, jwtSecret, { expiresIn: "12h" });

const call = async (path: string, options: { method?: "GET" | "POST" | "DELETE"; token?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
};

const freeze = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FROZEN_UTC));
};

const clearOwnRows = async () => {
  const seedIds = Object.values(ids);
  await db.block.deleteMany({ where: { OR: [{ blockerId: { in: seedIds } }, { targetUserId: { in: seedIds } }] } });
  await db.heart.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.chatRequest.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.recommendationItem.deleteMany({ where: { viewerId: { in: seedIds }, recommendationDate: SERVICE_DATE } });
  await db.refreshToken.deleteMany({ where: { userId: { in: seedIds }, tokenDate: SERVICE_DATE } });
  await db.dailyRefreshInventory.deleteMany({ where: { serviceDate: SERVICE_DATE } });
  await db.dailyFortune.deleteMany({ where: { userId: { in: seedIds }, fortuneDate: SERVICE_DATE } });
};

const openDay = (email: string) => call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids[email]) });

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  jwtSecret = (await import("../src/config.js")).config.jwtSecret;
  db = await loadPrisma();

  const users = await db.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true, email: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  expect(Object.keys(ids)).toHaveLength(EMAILS.length);
  await clearOwnRows();

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

beforeEach(async () => {
  vi.useRealTimers();
  await clearOwnRows();
});

afterAll(async () => {
  vi.useRealTimers();
  await clearOwnRows();
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await db.$disconnect();
});

describe("POST /api/v1/me/blocks", () => {
  it("차단하고 다시 차단해도 같은 정보를 돌려준다", async () => {
    freeze();
    const blockerId = ids["demo@kkagung.local"];
    const token = tokenFor(blockerId);
    const targetId = ids["user4@kkagung.local"].toString();

    const first = await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: targetId } });
    const again = await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: targetId } });

    expect(first.status).toBe(201);
    expect(first.body.data.blocked).toBe(true);
    expect(Object.keys(first.body.data).sort()).toEqual(["blocked", "blockedAt", "targetUserId"]);
    expect(again.status).toBe(201);
    expect(again.body.data).toEqual(first.body.data);
    expect(await db.block.count({ where: { blockerId, targetUserId: BigInt(targetId) } })).toBe(1);
  });

  it("동시에 5번 차단해도 행은 하나만 생긴다", async () => {
    freeze();
    const blockerId = ids["demo@kkagung.local"];
    const token = tokenFor(blockerId);
    const targetId = ids["user4@kkagung.local"].toString();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: targetId } })),
    );

    for (const result of results) expect(result.status).toBe(201);
    expect(await db.block.count({ where: { blockerId, targetUserId: BigInt(targetId) } })).toBe(1);
  });

  it("자신 차단은 400, 없는 사용자는 404, 토큰이 없으면 401 이다", async () => {
    freeze();
    const me = ids["demo@kkagung.local"];
    const token = tokenFor(me);

    const self = await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: me.toString() } });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe("SELF_ACTION_NOT_ALLOWED");

    const missing = await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: "99999999" } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RESOURCE_NOT_FOUND");

    const noToken = await call("/api/v1/me/blocks", { method: "POST", body: { targetUserId: "2" } });
    expect(noToken.status).toBe(401);
  });
});

describe("차단의 효과", () => {
  it("차단한 상대는 추천에서 빠지고 하트·채팅 요청이 거절된다", async () => {
    freeze();
    const blockerId = ids["demo@kkagung.local"];
    const token = tokenFor(blockerId);
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;

    await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: targetId } });

    const hearted = await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token });
    expect(hearted.status).toBe(403);
    expect(hearted.body.error.code).toBe("TARGET_BLOCKED");

    const requested = await call("/api/v1/chat-requests", { method: "POST", token, body: { targetUserId: targetId, message: "안녕하세요" } });
    expect(requested.status).toBe(403);
    expect(requested.body.error.code).toBe("TARGET_BLOCKED");

    // 다음 묶음을 새로 뽑으면 차단한 상대는 후보에서 빠진다.
    await db.recommendationItem.deleteMany({ where: { viewerId: blockerId, recommendationDate: SERVICE_DATE } });
    const reopened = await call("/api/v1/daily/open", { method: "POST", token });
    expect(reopened.body.data.cards.map((card: { userId: string }) => card.userId)).not.toContain(targetId);
  });
});

describe("GET /api/v1/me/blocks", () => {
  it("이름과 차단 시각만 담고 공개 이미지는 넣지 않는다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const targetId = ids["user4@kkagung.local"].toString();
    await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: targetId } });

    const listed = await call("/api/v1/me/blocks", { token });

    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body.data).sort()).toEqual(["hasMore", "items", "nextCursor"]);
    expect(listed.body.data.items).toHaveLength(1);
    expect(Object.keys(listed.body.data.items[0]).sort()).toEqual(["blockedAt", "displayName", "targetUserId"]);
    expect(listed.body.data.items[0].targetUserId).toBe(targetId);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "publicImage"]) {
      expect(listed.text).not.toContain(forbidden);
    }
  });
});

describe("DELETE /api/v1/me/blocks/:targetUserId", () => {
  it("해제하면 행이 사라지고, 없는 차단은 404 를 반환한다", async () => {
    freeze();
    const blockerId = ids["demo@kkagung.local"];
    const token = tokenFor(blockerId);
    const targetId = ids["user4@kkagung.local"].toString();
    await call("/api/v1/me/blocks", { method: "POST", token, body: { targetUserId: targetId } });

    const removed = await call(`/api/v1/me/blocks/${targetId}`, { method: "DELETE", token });
    expect(removed.status).toBe(200);
    expect(removed.body.data.blocked).toBe(false);
    expect(await db.block.count({ where: { blockerId, targetUserId: BigInt(targetId) } })).toBe(0);

    const again = await call(`/api/v1/me/blocks/${targetId}`, { method: "DELETE", token });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("BLOCK_NOT_FOUND");
  });
});
