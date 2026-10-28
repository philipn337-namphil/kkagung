import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// 시드 계정은 읽기만 한다. 이 파일이 만든 하트·차단·요청·운세·추천 행만 지운다.
const EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local", "user5@kkagung.local", "suspended@kkagung.local"];

// KST 2026-11-05 09:00 = UTC 2026-11-05T00:00Z → 서비스 날짜 2026-11-05
const FROZEN_UTC = "2026-11-05T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-11-05T00:00:00Z");

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let jwtIssuer = "";
let jwtAudience = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ role: "USER" }, jwtSecret, { subject: userId.toString(), expiresIn: "12h", issuer: jwtIssuer, audience: jwtAudience, jwtid: crypto.randomUUID() });

const call = async (path: string, options: { method?: "GET" | "POST" | "DELETE"; token?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers });
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
  await db.block.deleteMany({ where: { OR: [{ blockerId: { in: seedIds } }, { targetUserId: { in: seedIds } }] } });
  await db.chatRequest.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.recommendationItem.deleteMany({ where: { viewerId: { in: seedIds }, recommendationDate: SERVICE_DATE } });
  await db.refreshToken.deleteMany({ where: { userId: { in: seedIds }, tokenDate: SERVICE_DATE } });
  await db.dailyRefreshInventory.deleteMany({ where: { serviceDate: SERVICE_DATE } });
  await db.dailyFortune.deleteMany({ where: { userId: { in: seedIds }, fortuneDate: SERVICE_DATE } });
};

/** 하트를 보낼 자격을 만들려면 그날 카드에 노출돼 있어야 한다. 운세를 열어 카드를 만든다. */
const openDay = (email: string) => call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids[email]) });

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  const appConfig = (await import("../src/config.js")).config; jwtSecret = appConfig.jwtSecret; jwtIssuer = appConfig.jwtIssuer; jwtAudience = appConfig.jwtAudience;
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

describe("POST /api/v1/cards/:targetUserId/hearts", () => {
  it("오늘 카드에 노출된 상대에게 하트를 보낸다", async () => {
    freeze();
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;

    const sent = await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(sent.status).toBe(201);
    expect(sent.body.data.hearted).toBe(true);
    expect(sent.body.data.targetUserId).toBe(targetId);
    expect(typeof sent.body.data.sentAt).toBe("string");
  });

  it("같은 상대에게 다시 보내면 409 HEART_ALREADY_SENT 이고 하트는 하나다", async () => {
    freeze();
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    const token = tokenFor(ids["demo@kkagung.local"]);

    await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token });
    const again = await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("HEART_ALREADY_SENT");
    expect(await db.heart.count({ where: { senderId: ids["demo@kkagung.local"], receiverId: BigInt(targetId) } })).toBe(1);
  });

  it("동시에 5번 보내도 활성 하트는 하나만 생긴다", async () => {
    freeze();
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    const token = tokenFor(ids["demo@kkagung.local"]);

    const results = await Promise.all(Array.from({ length: 5 }, () => call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token })));

    for (const result of results) expect([201, 409]).toContain(result.status);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(await db.heart.count({ where: { senderId: ids["demo@kkagung.local"], receiverId: BigInt(targetId), canceledAt: null } })).toBe(1);
  });

  it("자신에게는 400 SELF_ACTION_NOT_ALLOWED 를 반환한다", async () => {
    freeze();
    const me = ids["demo@kkagung.local"];
    const sent = await call(`/api/v1/cards/${me}/hearts`, { method: "POST", token: tokenFor(me) });

    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe("SELF_ACTION_NOT_ALLOWED");
  });

  it("차단한 상대에게는 403 TARGET_BLOCKED 를 반환한다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    await db.block.create({ data: { blockerId: viewerId, targetUserId: BigInt(targetId) } });

    const sent = await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token: tokenFor(viewerId) });

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("TARGET_BLOCKED");
  });

  it("상대가 나를 차단했으면 403 BLOCKED_BY_TARGET 을 반환한다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    await db.block.create({ data: { blockerId: BigInt(targetId), targetUserId: viewerId } });

    const sent = await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token: tokenFor(viewerId) });

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("BLOCKED_BY_TARGET");
  });

  it("정지된 상대에게는 403 TARGET_UNAVAILABLE 을 반환한다", async () => {
    freeze();
    const sent = await call(`/api/v1/cards/${ids["suspended@kkagung.local"]}/hearts`, { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("TARGET_UNAVAILABLE");
  });

  it("없는 사용자에게는 404 RECOMMENDATION_NOT_FOUND 를 반환한다", async () => {
    freeze();
    const sent = await call("/api/v1/cards/99999999/hearts", { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(sent.status).toBe(404);
    expect(sent.body.error.code).toBe("RECOMMENDATION_NOT_FOUND");
  });

  it("토큰이 없으면 401 을 반환한다", async () => {
    freeze();
    const sent = await call(`/api/v1/cards/${ids["user4@kkagung.local"]}/hearts`, { method: "POST" });

    expect(sent.status).toBe(401);
    expect(sent.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("DELETE /api/v1/cards/:targetUserId/hearts", () => {
  it("하트를 취소하면 행은 남고 취소 시각이 기록된다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    const token = tokenFor(viewerId);
    await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token });

    const canceled = await call(`/api/v1/cards/${targetId}/hearts`, { method: "DELETE", token });

    expect(canceled.status).toBe(200);
    expect(canceled.body.data.hearted).toBe(false);
    const row = await db.heart.findUniqueOrThrow({ where: { senderId_receiverId: { senderId: viewerId, receiverId: BigInt(targetId) } } });
    expect(row.canceledAt).not.toBeNull();
  });

  it("이미 취소한 하트를 다시 취소해도 같은 결과를 준다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    const token = tokenFor(viewerId);
    await call(`/api/v1/cards/${targetId}/hearts`, { method: "POST", token });
    const first = await call(`/api/v1/cards/${targetId}/hearts`, { method: "DELETE", token });
    const second = await call(`/api/v1/cards/${targetId}/hearts`, { method: "DELETE", token });

    expect(second.status).toBe(first.status);
    expect(second.body.data).toEqual(first.body.data);
  });

  it("보낸 적 없는 하트를 취소하면 404 HEART_NOT_FOUND 를 반환한다", async () => {
    freeze();
    const canceled = await call(`/api/v1/cards/${ids["user4@kkagung.local"]}/hearts`, { method: "DELETE", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(canceled.status).toBe(404);
    expect(canceled.body.error.code).toBe("HEART_NOT_FOUND");
  });
});

describe("GET /api/v1/hearts/received", () => {
  it("발신자를 공개 카드 형태로만 보여주고 금지 필드가 없다", async () => {
    freeze();
    const senderId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const receiverId = BigInt(opened.body.data.cards[0].userId as string);
    await call(`/api/v1/cards/${receiverId}/hearts`, { method: "POST", token: tokenFor(senderId) });

    const received = await call("/api/v1/hearts/received", { token: tokenFor(receiverId) });

    expect(received.status).toBe(200);
    expect(Object.keys(received.body.data).sort()).toEqual(["hasMore", "items", "nextCursor"]);
    expect(received.body.data.items).toHaveLength(1);
    const item = received.body.data.items[0];
    expect(Object.keys(item).sort()).toEqual(["chatRequestStatus", "heartId", "receivedAt", "sender"]);
    expect(item.sender.userId).toBe(senderId.toString());
    expect(item.chatRequestStatus).toBe("NONE");
    expect(Object.keys(item.sender).sort()).toEqual([
      "age", "animalFace", "badges", "gender", "heightCm",
      "jobCategory", "mbti", "publicImage", "recommendReason", "regionLabel", "userId",
    ]);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "ORIGINAL_PRIVATE", "intro"]) {
      expect(received.text).not.toContain(forbidden);
    }
  });

  it("취소된 하트와 차단한 발신자의 하트는 목록에서 빠진다", async () => {
    freeze();
    const senderId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const receiverId = BigInt(opened.body.data.cards[0].userId as string);
    await call(`/api/v1/cards/${receiverId}/hearts`, { method: "POST", token: tokenFor(senderId) });
    await call(`/api/v1/cards/${receiverId}/hearts`, { method: "DELETE", token: tokenFor(senderId) });

    const afterCancel = await call("/api/v1/hearts/received", { token: tokenFor(receiverId) });
    expect(afterCancel.body.data.items).toHaveLength(0);

    await call(`/api/v1/cards/${receiverId}/hearts`, { method: "POST", token: tokenFor(senderId) });
    await db.block.create({ data: { blockerId: receiverId, targetUserId: senderId } });

    const afterBlock = await call("/api/v1/hearts/received", { token: tokenFor(receiverId) });
    expect(afterBlock.body.data.items).toHaveLength(0);
  });

  it("토큰이 없으면 401 을 반환한다", async () => {
    freeze();
    const received = await call("/api/v1/hearts/received");

    expect(received.status).toBe(401);
    expect(received.body.error.code).toBe("UNAUTHORIZED");
  });
});
