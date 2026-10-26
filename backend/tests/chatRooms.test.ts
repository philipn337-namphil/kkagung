import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local", "user5@kkagung.local"];

// KST 2026-11-19 09:00 = UTC 2026-11-19T00:00Z → 서비스 날짜 2026-11-19
const FROZEN_UTC = "2026-11-19T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-11-19T00:00:00Z");

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
  return { status: response.status, text, body: JSON.parse(text), headers: response.headers };
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

/** demo 가 카드 상대에게 요청을 보내고 상대가 수락해 방을 만든다. */
const openRoom = async () => {
  const senderId = ids["demo@kkagung.local"];
  const opened = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(senderId) });
  const partnerId = BigInt(opened.body.data.cards[0].userId as string);
  const created = await call("/api/v1/chat-requests", {
    method: "POST",
    token: tokenFor(senderId),
    body: { targetUserId: partnerId.toString(), message: "이야기 나눠 볼까요?" },
  });
  const accepted = await call(`/api/v1/chat-requests/${created.body.data.requestId}/accept`, { method: "POST", token: tokenFor(partnerId) });
  return { senderId, partnerId, roomId: accepted.body.data.roomId as string };
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

describe("GET /api/v1/chat-rooms/:roomId", () => {
  it("참여자는 상대의 공개 프로필을 받고 응답은 캐시되지 않는다", async () => {
    freeze();
    const { senderId, partnerId, roomId } = await openRoom();

    const room = await call(`/api/v1/chat-rooms/${roomId}`, { token: tokenFor(senderId) });

    expect(room.status).toBe(200);
    expect(room.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(room.body.data).sort()).toEqual(["blockedByMe", "blockedByPartner", "canSendMessage", "createdAt", "partner", "roomId"]);
    expect(room.body.data.partner.userId).toBe(partnerId.toString());
    expect(room.body.data.canSendMessage).toBe(true);
    expect(Array.isArray(room.body.data.partner.originalImages)).toBe(true);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "ORIGINAL_PRIVATE"]) {
      expect(room.text).not.toContain(forbidden);
    }
  });

  it("참여자가 아니면 403 NOT_ROOM_MEMBER, 없는 방은 404 를 반환한다", async () => {
    freeze();
    const { roomId } = await openRoom();

    const byOther = await call(`/api/v1/chat-rooms/${roomId}`, { token: tokenFor(ids["user1@kkagung.local"]) });
    expect(byOther.status).toBe(403);
    expect(byOther.body.error.code).toBe("NOT_ROOM_MEMBER");

    const missing = await call("/api/v1/chat-rooms/99999999", { token: tokenFor(ids["demo@kkagung.local"]) });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("CHAT_ROOM_NOT_FOUND");
  });

  it("차단하면 사진을 주지 않고 전송을 막는다", async () => {
    freeze();
    const { senderId, partnerId, roomId } = await openRoom();
    await db.block.create({ data: { blockerId: senderId, targetUserId: partnerId } });

    const room = await call(`/api/v1/chat-rooms/${roomId}`, { token: tokenFor(senderId) });

    expect(room.status).toBe(200);
    expect(room.body.data.blockedByMe).toBe(true);
    expect(room.body.data.canSendMessage).toBe(false);
    expect(room.body.data.partner.originalImages).toEqual([]);
  });
});

describe("메시지", () => {
  it("보내고 목록으로 읽는다", async () => {
    freeze();
    const { senderId, roomId } = await openRoom();
    const token = tokenFor(senderId);

    const sent = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: { body: "안녕하세요" } });
    expect(sent.status).toBe(201);
    expect(Object.keys(sent.body.data).sort()).toEqual(["body", "messageId", "senderId", "sentAt"]);

    const list = await call(`/api/v1/chat-rooms/${roomId}/messages`, { token });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].body).toBe("안녕하세요");
    for (const forbidden of ["email", "@kkagung.local", "password"]) expect(list.text).not.toContain(forbidden);
  });

  it("같은 재시도 키로 두 번 보내면 메시지는 하나다", async () => {
    freeze();
    const { senderId, roomId } = await openRoom();
    const token = tokenFor(senderId);
    const payload = { body: "같은 메시지", clientMessageId: "retry-key-1" };

    const first = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: payload });
    const second = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: payload });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.messageId).toBe(first.body.data.messageId);
    expect(await db.chatMessage.count({ where: { roomId: BigInt(roomId) } })).toBe(1);
  });

  it("같은 재시도 키로 동시에 5번 보내도 메시지는 하나다", async () => {
    freeze();
    const { senderId, roomId } = await openRoom();
    const token = tokenFor(senderId);
    const payload = { body: "동시 전송", clientMessageId: "retry-key-2" };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: payload })),
    );

    for (const result of results) expect(result.status).toBe(201);
    const uniqueIds = new Set(results.map((result) => result.body.data.messageId));
    expect(uniqueIds.size).toBe(1);
    expect(await db.chatMessage.count({ where: { roomId: BigInt(roomId) } })).toBe(1);
  });

  it("빈 메시지와 너무 긴 메시지는 400 을 반환한다", async () => {
    freeze();
    const { senderId, roomId } = await openRoom();
    const token = tokenFor(senderId);

    const empty = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: { body: "" } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("VALIDATION_ERROR");

    const tooLong = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: { body: "가".repeat(1001) } });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("차단 상태에서는 전송이 거절되고 과거 메시지는 읽을 수 있다", async () => {
    freeze();
    const { senderId, partnerId, roomId } = await openRoom();
    const token = tokenFor(senderId);
    await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: { body: "차단 전 메시지" } });
    await db.block.create({ data: { blockerId: partnerId, targetUserId: senderId } });

    const blocked = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: { body: "차단 후 메시지" } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("BLOCKED_BY_TARGET");

    const list = await call(`/api/v1/chat-rooms/${roomId}/messages`, { token });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
  });

  it("참여자가 아니면 메시지를 보내거나 읽을 수 없다", async () => {
    freeze();
    const { roomId } = await openRoom();
    const token = tokenFor(ids["user1@kkagung.local"]);

    const read = await call(`/api/v1/chat-rooms/${roomId}/messages`, { token });
    expect(read.status).toBe(403);

    const write = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token, body: { body: "끼어들기" } });
    expect(write.status).toBe(403);
  });
});

describe("GET /api/v1/chat-rooms", () => {
  it("내 방 목록에 상대 공개 카드와 읽지 않은 수가 담긴다", async () => {
    freeze();
    const { senderId, partnerId, roomId } = await openRoom();
    await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token: tokenFor(partnerId), body: { body: "먼저 보냅니다" } });

    const rooms = await call("/api/v1/chat-rooms", { token: tokenFor(senderId) });

    expect(rooms.status).toBe(200);
    expect(Object.keys(rooms.body.data).sort()).toEqual(["hasMore", "items", "nextCursor"]);
    expect(rooms.body.data.items).toHaveLength(1);
    const item = rooms.body.data.items[0];
    expect(Object.keys(item).sort()).toEqual(["createdAt", "lastMessage", "partner", "roomId", "unreadCount"]);
    expect(item.partner.userId).toBe(partnerId.toString());
    expect(item.unreadCount).toBe(1);
    expect(item.lastMessage.preview).toBe("먼저 보냅니다");
    // 목록에는 원본 사진이 없고 공개 카드 필드만 담긴다.
    expect(Object.keys(item.partner).sort()).toEqual([
      "age", "animalFace", "badges", "displayName", "gender", "heightCm",
      "jobCategory", "mbti", "publicImage", "recommendReason", "regionLabel", "userId",
    ]);
  });

  it("메시지를 읽으면 읽지 않은 수가 0 이 된다", async () => {
    freeze();
    const { senderId, partnerId, roomId } = await openRoom();
    await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token: tokenFor(partnerId), body: { body: "읽어주세요" } });
    await call(`/api/v1/chat-rooms/${roomId}/messages`, { token: tokenFor(senderId) });

    const rooms = await call("/api/v1/chat-rooms", { token: tokenFor(senderId) });

    expect(rooms.body.data.items[0].unreadCount).toBe(0);
  });

  it("토큰이 없으면 401 을 반환한다", async () => {
    freeze();
    const rooms = await call("/api/v1/chat-rooms");
    expect(rooms.status).toBe(401);
  });
});
