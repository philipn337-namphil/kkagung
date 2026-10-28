import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local", "user5@kkagung.local", "suspended@kkagung.local"];

// KST 2026-11-12 09:00 = UTC 2026-11-12T00:00Z → 서비스 날짜 2026-11-12
const FROZEN_UTC = "2026-11-12T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-11-12T00:00:00Z");

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let jwtIssuer = "";
let jwtAudience = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ role: "USER" }, jwtSecret, { subject: userId.toString(), expiresIn: "12h", issuer: jwtIssuer, audience: jwtAudience, jwtid: crypto.randomUUID() });

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
  const rooms = await db.chatRoom.findMany({
    where: { chatRequest: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } },
    select: { id: true },
  });
  const roomIds = rooms.map((room) => room.id);
  if (roomIds.length > 0) {
    await db.chatMessage.deleteMany({ where: { roomId: { in: roomIds } } });
    await db.chatRoomMember.deleteMany({ where: { roomId: { in: roomIds } } });
    await db.chatRoom.deleteMany({ where: { id: { in: roomIds } } });
  }
  await db.chatRequest.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.heart.deleteMany({ where: { OR: [{ senderId: { in: seedIds } }, { receiverId: { in: seedIds } }] } });
  await db.block.deleteMany({ where: { OR: [{ blockerId: { in: seedIds } }, { targetUserId: { in: seedIds } }] } });
  await db.recommendationItem.deleteMany({ where: { viewerId: { in: seedIds }, recommendationDate: SERVICE_DATE } });
  await db.refreshToken.deleteMany({ where: { userId: { in: seedIds }, tokenDate: SERVICE_DATE } });
  await db.dailyRefreshInventory.deleteMany({ where: { serviceDate: SERVICE_DATE } });
  await db.dailyFortune.deleteMany({ where: { userId: { in: seedIds }, fortuneDate: SERVICE_DATE } });
};

const openDay = (email: string) => call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids[email]) });

/** 요청을 보낼 자격을 만든 뒤 PENDING 요청 하나를 만든다. */
const makeRequest = async (senderEmail: string) => {
  const opened = await openDay(senderEmail);
  const targetId = opened.body.data.cards[0].userId as string;
  const created = await call("/api/v1/chat-requests", {
    method: "POST",
    token: tokenFor(ids[senderEmail]),
    body: { targetUserId: targetId, message: "이야기 나눠 볼까요?" },
  });
  return { targetId, created };
};

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

describe("POST /api/v1/chat-requests", () => {
  it("오늘 노출된 상대에게 요청을 만든다", async () => {
    freeze();
    const { targetId, created } = await makeRequest("demo@kkagung.local");

    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("PENDING");
    expect(created.body.data.targetUserId).toBe(targetId);
    expect(Object.keys(created.body.data).sort()).toEqual(["createdAt", "requestId", "status", "targetUserId"]);
  });

  it("동시에 5번 보내도 PENDING 요청은 하나만 생긴다", async () => {
    freeze();
    const senderId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    const token = tokenFor(senderId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call("/api/v1/chat-requests", { method: "POST", token, body: { targetUserId: targetId, message: "안녕하세요" } })),
    );

    for (const result of results) expect([201, 403, 409]).toContain(result.status);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(await db.chatRequest.count({ where: { senderId, receiverId: BigInt(targetId), status: "PENDING" } })).toBe(1);
  });

  it("자신에게 보내면 400, 빈 메시지는 400 을 반환한다", async () => {
    freeze();
    const me = ids["demo@kkagung.local"];
    const toSelf = await call("/api/v1/chat-requests", { method: "POST", token: tokenFor(me), body: { targetUserId: me.toString(), message: "안녕" } });
    expect(toSelf.status).toBe(400);
    expect(toSelf.body.error.code).toBe("SELF_ACTION_NOT_ALLOWED");

    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    const empty = await call("/api/v1/chat-requests", { method: "POST", token: tokenFor(me), body: { targetUserId: targetId, message: "" } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("오늘 노출되지 않은 상대에게는 403 CHAT_REQUEST_NOT_ALLOWED 를 반환한다", async () => {
    freeze();
    const sent = await call("/api/v1/chat-requests", {
      method: "POST",
      token: tokenFor(ids["demo@kkagung.local"]),
      body: { targetUserId: ids["user1@kkagung.local"].toString(), message: "안녕하세요" },
    });

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("CHAT_REQUEST_NOT_ALLOWED");
  });

  it("차단 관계면 요청을 거절한다", async () => {
    freeze();
    const senderId = ids["demo@kkagung.local"];
    const opened = await openDay("demo@kkagung.local");
    const targetId = opened.body.data.cards[0].userId as string;
    await db.block.create({ data: { blockerId: senderId, targetUserId: BigInt(targetId) } });

    const sent = await call("/api/v1/chat-requests", { method: "POST", token: tokenFor(senderId), body: { targetUserId: targetId, message: "안녕하세요" } });

    expect(sent.status).toBe(403);
    expect(sent.body.error.code).toBe("TARGET_BLOCKED");
  });

  it("토큰이 없으면 401 을 반환한다", async () => {
    freeze();
    const sent = await call("/api/v1/chat-requests", { method: "POST", body: { targetUserId: "2", message: "안녕하세요" } });
    expect(sent.status).toBe(401);
  });
});

describe("요청 처리", () => {
  it("수락하면 방 1개와 참여자 2명이 생긴다", async () => {
    freeze();
    const { targetId, created } = await makeRequest("demo@kkagung.local");
    const requestId = created.body.data.requestId as string;

    const accepted = await call(`/api/v1/chat-requests/${requestId}/accept`, { method: "POST", token: tokenFor(BigInt(targetId)) });

    expect(accepted.status).toBe(201);
    expect(accepted.body.data.status).toBe("ACCEPTED");
    expect(typeof accepted.body.data.roomId).toBe("string");
    const roomId = BigInt(accepted.body.data.roomId as string);
    expect(await db.chatRoomMember.count({ where: { roomId } })).toBe(2);
    expect(await db.chatRoom.count({ where: { chatRequestId: BigInt(requestId) } })).toBe(1);
  });

  it("동시에 3번 수락해도 방은 하나만 생긴다", async () => {
    freeze();
    const { targetId, created } = await makeRequest("demo@kkagung.local");
    const requestId = created.body.data.requestId as string;
    const token = tokenFor(BigInt(targetId));

    const results = await Promise.all(
      Array.from({ length: 3 }, () => call(`/api/v1/chat-requests/${requestId}/accept`, { method: "POST", token })),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    for (const failed of results.filter((result) => result.status !== 201)) {
      expect(failed.status).toBe(409);
      expect(failed.body.error.code).toBe("CHAT_REQUEST_ALREADY_RESOLVED");
    }
    expect(await db.chatRoom.count({ where: { chatRequestId: BigInt(requestId) } })).toBe(1);
  });

  it("거절하면 방을 만들지 않고, 다시 처리하면 409 를 반환한다", async () => {
    freeze();
    const { targetId, created } = await makeRequest("demo@kkagung.local");
    const requestId = created.body.data.requestId as string;
    const token = tokenFor(BigInt(targetId));

    const rejected = await call(`/api/v1/chat-requests/${requestId}/reject`, { method: "POST", token });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe("REJECTED");
    expect(await db.chatRoom.count({ where: { chatRequestId: BigInt(requestId) } })).toBe(0);

    const again = await call(`/api/v1/chat-requests/${requestId}/accept`, { method: "POST", token });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CHAT_REQUEST_ALREADY_RESOLVED");
  });

  it("무시하면 수신자 목록에서 숨고 발신자에게는 대기 중으로 보인다", async () => {
    freeze();
    const senderId = ids["demo@kkagung.local"];
    const { targetId, created } = await makeRequest("demo@kkagung.local");
    const requestId = created.body.data.requestId as string;
    const receiverToken = tokenFor(BigInt(targetId));

    const ignored = await call(`/api/v1/chat-requests/${requestId}/ignore`, { method: "POST", token: receiverToken });
    expect(ignored.status).toBe(200);
    expect(ignored.body.data.status).toBe("IGNORED");

    const received = await call("/api/v1/chat-requests/received", { token: receiverToken });
    expect(received.body.data.items).toHaveLength(0);

    const sent = await call("/api/v1/chat-requests/sent", { token: tokenFor(senderId) });
    expect(sent.body.data.items).toHaveLength(1);
    expect(sent.body.data.items[0].status).toBe("PENDING");
  });

  it("수신자가 아니면 403 FORBIDDEN, 없는 요청은 404 를 반환한다", async () => {
    freeze();
    const { created } = await makeRequest("demo@kkagung.local");
    const requestId = created.body.data.requestId as string;

    const byOther = await call(`/api/v1/chat-requests/${requestId}/accept`, { method: "POST", token: tokenFor(ids["user1@kkagung.local"]) });
    expect(byOther.status).toBe(403);
    expect(byOther.body.error.code).toBe("FORBIDDEN");

    const missing = await call("/api/v1/chat-requests/99999999/accept", { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("CHAT_REQUEST_NOT_FOUND");
  });
});

describe("목록", () => {
  it("받은 목록은 발신자를 공개 카드로만 담고 금지 필드가 없다", async () => {
    freeze();
    const senderId = ids["demo@kkagung.local"];
    const { targetId } = await makeRequest("demo@kkagung.local");

    const received = await call("/api/v1/chat-requests/received", { token: tokenFor(BigInt(targetId)) });

    expect(received.status).toBe(200);
    expect(Object.keys(received.body.data).sort()).toEqual(["hasMore", "items", "nextCursor"]);
    const item = received.body.data.items[0];
    expect(Object.keys(item).sort()).toEqual(["createdAt", "message", "requestId", "respondedAt", "sender", "status"]);
    expect(item.sender.userId).toBe(senderId.toString());
    expect(Object.keys(item.sender).sort()).toEqual([
      "age", "animalFace", "badges", "gender", "heightCm",
      "jobCategory", "mbti", "publicImage", "recommendReason", "regionLabel", "userId",
    ]);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "ORIGINAL_PRIVATE", "intro"]) {
      expect(received.text).not.toContain(forbidden);
    }
  });

  it("보낸 목록은 상대를 target 으로 담는다", async () => {
    freeze();
    const { targetId } = await makeRequest("demo@kkagung.local");

    const sent = await call("/api/v1/chat-requests/sent", { token: tokenFor(ids["demo@kkagung.local"]) });

    expect(sent.status).toBe(200);
    const item = sent.body.data.items[0];
    expect(Object.keys(item).sort()).toEqual(["createdAt", "message", "requestId", "respondedAt", "status", "target"]);
    expect(item.target.userId).toBe(targetId);
  });
});
