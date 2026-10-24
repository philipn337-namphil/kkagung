import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local", "suspended@kkagung.local"];

// KST 2026-11-26 09:00 = UTC 2026-11-26T00:00Z → 서비스 날짜 2026-11-26
const FROZEN_UTC = "2026-11-26T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-11-26T00:00:00Z");

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ sub: userId.toString(), role: "USER" }, jwtSecret, { expiresIn: "12h" });

const call = async (path: string, options: { method?: "GET" | "POST"; token?: string; body?: unknown } = {}) => {
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
  await db.heart.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.chatRequest.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.block.deleteMany({ where: { OR: [{ blockerId: { in: seedIds } }, { targetUserId: { in: seedIds } }] } });
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

describe("GET /api/v1/cards/:targetUserId", () => {
  it("오늘 추천된 상대의 카드를 공개 필드만으로 반환한다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;

    const detail = await call(`/api/v1/cards/${targetId}`, { token });

    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body.data).sort()).toEqual(["card", "chatRequestStatus", "hearted"]);
    expect(detail.body.data.card.userId).toBe(targetId);
    expect(Object.keys(detail.body.data.card).sort()).toEqual([
      "age", "animalFace", "badges", "displayName", "gender", "heightCm",
      "jobCategory", "mbti", "publicImage", "recommendReason", "regionLabel", "userId",
    ]);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "ORIGINAL_PRIVATE", "intro"]) {
      expect(detail.text).not.toContain(forbidden);
    }
  });

  it("하트와 채팅 요청 상태를 표시한다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;

    const before = await call(`/api/v1/cards/${targetId}`, { token });
    expect(before.body.data.hearted).toBe(false);
    expect(before.body.data.chatRequestStatus).toBe("NONE");

    await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token });
    await call("/api/v1/chat-requests", { method: "POST", token, body: { targetUserId: targetId, message: "이야기 나눠 볼까요?" } });

    const after = await call(`/api/v1/cards/${targetId}`, { token });
    expect(after.body.data.hearted).toBe(true);
    expect(after.body.data.chatRequestStatus).toBe("PENDING");
  });

  it("오늘 노출되지 않은 상대와 없는 ID 는 404 를 반환한다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    await openDay("demo@kkagung.local");

    const notShown = await call(`/api/v1/cards/${ids["user1@kkagung.local"]}`, { token });
    expect(notShown.status).toBe(404);
    expect(notShown.body.error.code).toBe("RECOMMENDATION_NOT_FOUND");

    const missing = await call("/api/v1/cards/99999999", { token });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RECOMMENDATION_NOT_FOUND");
  });

  it("본인 카드는 404 를 반환한다", async () => {
    freeze();
    const me = ids["demo@kkagung.local"];
    const mine = await call(`/api/v1/cards/${me}`, { token: tokenFor(me) });

    expect(mine.status).toBe(404);
    expect(mine.body.error.code).toBe("RECOMMENDATION_NOT_FOUND");
  });

  it("정지된 상대는 403 TARGET_UNAVAILABLE 을 반환한다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const suspendedId = ids["suspended@kkagung.local"];
    // 정지 계정은 추천에 오르지 않으므로, 하트를 받은 상태를 만들어 조회 자격만 준다.
    await db.heart.create({ data: { senderId: suspendedId, receiverId: viewerId } });

    const detail = await call(`/api/v1/cards/${suspendedId}`, { token: tokenFor(viewerId) });

    expect(detail.status).toBe(403);
    expect(detail.body.error.code).toBe("TARGET_UNAVAILABLE");
  });

  it("차단 관계는 양방향으로 거절한다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const token = tokenFor(viewerId);
    const opened = await openDay("demo@kkagung.local");
    const targetId = BigInt(opened.body.data.cards[0].userId as string);

    const myBlock = await db.block.create({ data: { blockerId: viewerId, targetUserId: targetId } });
    const blockedByMe = await call(`/api/v1/cards/${targetId}`, { token });
    expect(blockedByMe.status).toBe(403);
    expect(blockedByMe.body.error.code).toBe("TARGET_BLOCKED");
    await db.block.delete({ where: { id: myBlock.id } });

    await db.block.create({ data: { blockerId: targetId, targetUserId: viewerId } });
    const blockedByTarget = await call(`/api/v1/cards/${targetId}`, { token });
    expect(blockedByTarget.status).toBe(403);
    expect(blockedByTarget.body.error.code).toBe("BLOCKED_BY_TARGET");
  });

  it("토큰이 없으면 401 을 반환한다", async () => {
    freeze();
    const detail = await call(`/api/v1/cards/${ids["user4@kkagung.local"]}`);

    expect(detail.status).toBe(401);
    expect(detail.body.error.code).toBe("UNAUTHORIZED");
  });
});
