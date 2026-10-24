import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local"];

// KST 2026-12-10 09:00 = UTC 2026-12-10T00:00Z → 서비스 날짜 2026-12-10
const FROZEN_UTC = "2026-12-10T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-12-10T00:00:00Z");

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
  await db.report.deleteMany({ where: { reporterId: { in: seedIds } } });
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

/** 상대가 보낸 메시지가 있는 방을 만든다. */
const openRoomWithMessage = async () => {
  const senderId = ids["demo@kkagung.local"];
  const opened = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(senderId) });
  const partnerId = BigInt(opened.body.data.cards[0].userId as string);
  const created = await call("/api/v1/chat-requests", {
    method: "POST",
    token: tokenFor(senderId),
    body: { targetUserId: partnerId.toString(), message: "이야기 나눠 볼까요?" },
  });
  const accepted = await call(`/api/v1/chat-requests/${created.body.data.requestId}/accept`, { method: "POST", token: tokenFor(partnerId) });
  const roomId = accepted.body.data.roomId as string;
  const message = await call(`/api/v1/chat-rooms/${roomId}/messages`, { method: "POST", token: tokenFor(partnerId), body: { body: "상대가 보낸 메시지" } });
  return { senderId, partnerId, roomId, messageId: message.body.data.messageId as string };
};

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

describe("POST /api/v1/reports", () => {
  it("사용자를 신고하면 접수 번호와 상태만 돌려준다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);

    const filed = await call("/api/v1/reports", {
      method: "POST",
      token,
      body: { targetType: "USER", targetId: ids["user4@kkagung.local"].toString(), reasonCode: "ABUSE", detail: "욕설을 했습니다." },
    });

    expect(filed.status).toBe(201);
    expect(Object.keys(filed.body.data).sort()).toEqual(["createdAt", "reportId", "status"]);
    expect(filed.body.data.status).toBe("PENDING");
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "password", "resultNote", "handledBy"]) {
      expect(filed.text).not.toContain(forbidden);
    }
  });

  it("같은 대상·사유를 다시 신고하면 409 REPORT_ALREADY_EXISTS 를 반환한다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const payload = { targetType: "USER", targetId: ids["user4@kkagung.local"].toString(), reasonCode: "SPAM" };

    const first = await call("/api/v1/reports", { method: "POST", token, body: payload });
    const again = await call("/api/v1/reports", { method: "POST", token, body: payload });

    expect(first.status).toBe(201);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("REPORT_ALREADY_EXISTS");
    expect(await db.report.count({ where: { reporterId: ids["demo@kkagung.local"] } })).toBe(1);
  });

  it("동시에 5번 접수해도 행은 하나만 생긴다", async () => {
    freeze();
    const reporterId = ids["demo@kkagung.local"];
    const token = tokenFor(reporterId);
    const payload = { targetType: "USER", targetId: ids["user4@kkagung.local"].toString(), reasonCode: "SEXUAL" };

    const results = await Promise.all(Array.from({ length: 5 }, () => call("/api/v1/reports", { method: "POST", token, body: payload })));

    for (const result of results) expect([201, 409]).toContain(result.status);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(await db.report.count({ where: { reporterId } })).toBe(1);
  });

  it("다른 사유로는 같은 대상을 다시 신고할 수 있다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const targetId = ids["user4@kkagung.local"].toString();

    const spam = await call("/api/v1/reports", { method: "POST", token, body: { targetType: "USER", targetId, reasonCode: "SPAM" } });
    const abuse = await call("/api/v1/reports", { method: "POST", token, body: { targetType: "USER", targetId, reasonCode: "ABUSE" } });

    expect(spam.status).toBe(201);
    expect(abuse.status).toBe(201);
  });

  it("필수값 누락·잘못된 코드·너무 긴 설명은 400 을 반환한다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const targetId = ids["user4@kkagung.local"].toString();

    for (const body of [
      { targetType: "USER", targetId },
      { targetType: "GROUP", targetId, reasonCode: "SPAM" },
      { targetType: "USER", targetId, reasonCode: "NOT_A_CODE" },
      { targetType: "USER", targetId, reasonCode: "SPAM", detail: "가".repeat(501) },
    ]) {
      const invalid = await call("/api/v1/reports", { method: "POST", token, body });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("자신 신고는 400, 없는 대상은 404, 토큰이 없으면 401 이다", async () => {
    freeze();
    const me = ids["demo@kkagung.local"];
    const token = tokenFor(me);

    const self = await call("/api/v1/reports", { method: "POST", token, body: { targetType: "USER", targetId: me.toString(), reasonCode: "SPAM" } });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe("SELF_ACTION_NOT_ALLOWED");

    const missing = await call("/api/v1/reports", { method: "POST", token, body: { targetType: "USER", targetId: "99999999", reasonCode: "SPAM" } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RESOURCE_NOT_FOUND");

    const noToken = await call("/api/v1/reports", { method: "POST", body: { targetType: "USER", targetId: "2", reasonCode: "SPAM" } });
    expect(noToken.status).toBe(401);
  });

  it("메시지 신고는 방 참여자만 할 수 있다", async () => {
    freeze();
    const { senderId, messageId } = await openRoomWithMessage();

    const byMember = await call("/api/v1/reports", {
      method: "POST",
      token: tokenFor(senderId),
      body: { targetType: "MESSAGE", targetId: messageId, reasonCode: "ABUSE" },
    });
    expect(byMember.status).toBe(201);

    const byOutsider = await call("/api/v1/reports", {
      method: "POST",
      token: tokenFor(ids["user1@kkagung.local"]),
      body: { targetType: "MESSAGE", targetId: messageId, reasonCode: "ABUSE" },
    });
    expect(byOutsider.status).toBe(404);
    expect(byOutsider.body.error.code).toBe("RESOURCE_NOT_FOUND");

    const missingMessage = await call("/api/v1/reports", {
      method: "POST",
      token: tokenFor(senderId),
      body: { targetType: "MESSAGE", targetId: "99999999", reasonCode: "ABUSE" },
    });
    expect(missingMessage.status).toBe(404);
  });
});
