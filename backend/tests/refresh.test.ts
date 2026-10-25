import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// 먼 미래 날짜에 고정해 실제 날짜의 데이터와 섞이지 않게 한다.
// KST 2030-01-15 09:00 = UTC 2030-01-15T00:00Z → 서비스 날짜 2030-01-15
const FROZEN_UTC = "2030-01-15T00:00:00.000Z";
const SERVICE_DATE_TEXT = "2030-01-15";
const SERVICE_DATE = new Date(`${SERVICE_DATE_TEXT}T00:00:00Z`);

const VIEWERS = ["demo@kkagung.local", "user1@kkagung.local", "user2@kkagung.local", "user3@kkagung.local", "user4@kkagung.local"];

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let jwtIssuer = "";
let jwtAudience = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ role: "USER" }, jwtSecret, { subject: userId.toString(), expiresIn: "12h", issuer: jwtIssuer, audience: jwtAudience, jwtid: crypto.randomUUID() });

const call = async (path: string, options: { method?: "GET" | "POST"; token?: string } = {}) => {
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

const clearTestDay = async () => {
  const seedIds = Object.values(ids);
  await db.refreshToken.deleteMany({ where: { userId: { in: seedIds }, tokenDate: SERVICE_DATE } });
  await db.recommendationItem.deleteMany({ where: { viewerId: { in: seedIds }, recommendationDate: SERVICE_DATE } });
  await db.dailyFortune.deleteMany({ where: { userId: { in: seedIds }, fortuneDate: SERVICE_DATE } });
  await db.dailyRefreshInventory.deleteMany({ where: { serviceDate: SERVICE_DATE } });
};

const setStock = (total: number) =>
  db.dailyRefreshInventory.create({ data: { serviceDate: SERVICE_DATE, totalCount: total, remainingCount: total } });

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  const appConfig = (await import("../src/config.js")).config; jwtSecret = appConfig.jwtSecret; jwtIssuer = appConfig.jwtIssuer; jwtAudience = appConfig.jwtAudience;
  db = await loadPrisma();

  const users = await db.user.findMany({ where: { email: { in: VIEWERS } }, select: { id: true, email: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  expect(Object.keys(ids)).toHaveLength(VIEWERS.length);

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
  await clearTestDay();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await clearTestDay();
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await db.$disconnect();
});

describe("선착순 지급", () => {
  it("재고 2인 날 5명이 동시에 열면 2명만 받고 오류가 없다", async () => {
    await setStock(2);
    freeze();

    const results = await Promise.all(VIEWERS.map((email) => call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids[email]) })));

    for (const result of results) expect(result.status).toBe(200);
    const granted = results.filter((result) => result.body.data.refreshTicket.granted === true);
    const notGranted = results.filter((result) => result.body.data.refreshTicket.status === "NOT_GRANTED");
    expect(granted).toHaveLength(2);
    expect(notGranted).toHaveLength(3);

    const inventory = await db.dailyRefreshInventory.findUniqueOrThrow({ where: { serviceDate: SERVICE_DATE } });
    expect(inventory.remainingCount).toBe(0);
    expect(inventory.grantedCount).toBe(2);

    const tokens = await db.refreshToken.findMany({ where: { tokenDate: SERVICE_DATE }, orderBy: { grantedRank: "asc" } });
    expect(tokens).toHaveLength(2);
    expect(tokens.map((token) => token.grantedRank)).toEqual([1, 2]);
  });

  it("이미 받은 사람이 다시 열어도 권이 늘지 않는다", async () => {
    await setStock(2);
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);

    const first = await call("/api/v1/daily/open", { method: "POST", token });
    expect(first.body.data.refreshTicket.granted).toBe(true);

    const again = await call("/api/v1/daily/open", { method: "POST", token });
    expect(again.body.data.refreshTicket.granted).toBe(false);
    expect(again.body.data.refreshTicket.status).toBe("AVAILABLE");

    expect(await db.refreshToken.count({ where: { tokenDate: SERVICE_DATE } })).toBe(1);
    const inventory = await db.dailyRefreshInventory.findUniqueOrThrow({ where: { serviceDate: SERVICE_DATE } });
    expect(inventory.remainingCount).toBe(1);
  });

  it("재고 행이 없는 날에도 첫 호출이 오류 없이 재고를 만든다", async () => {
    freeze();
    expect(await db.dailyRefreshInventory.findUnique({ where: { serviceDate: SERVICE_DATE } })).toBeNull();

    const result = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(result.status).toBe(200);
    expect(result.body.data.refreshTicket.granted).toBe(true);
    const inventory = await db.dailyRefreshInventory.findUniqueOrThrow({ where: { serviceDate: SERVICE_DATE } });
    expect(inventory.totalCount).toBe(100);
    expect(inventory.remainingCount).toBe(99);
  });
});

describe("POST /api/v1/recommendations/refresh", () => {
  it("동시에 3번 눌러도 한 번만 성공한다", async () => {
    await setStock(5);
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const token = tokenFor(viewerId);
    await call("/api/v1/daily/open", { method: "POST", token });

    // 권을 쓰려면 보여줄 새 후보가 있어야 한다. 시드 후보가 적으므로 기본 묶음 일부를 비워 자리를 만든다.
    const initial = await db.recommendationItem.findMany({
      where: { viewerId, recommendationDate: SERVICE_DATE },
      orderBy: { displayOrder: "asc" },
      select: { id: true },
    });
    expect(initial.length).toBeGreaterThan(1);
    await db.recommendationItem.deleteMany({ where: { id: { in: initial.slice(1).map((row) => row.id) } } });

    const results = await Promise.all(Array.from({ length: 3 }, () => call("/api/v1/recommendations/refresh", { method: "POST", token })));

    const succeeded = results.filter((result) => result.status === 200);
    expect(succeeded).toHaveLength(1);
    for (const failed of results.filter((result) => result.status !== 200)) {
      expect(failed.status).toBe(409);
      expect(failed.body.error.code).toBe("REFRESH_TOKEN_ALREADY_USED");
    }
    const used = await db.refreshToken.findUniqueOrThrow({ where: { userId_tokenDate: { userId: ids["demo@kkagung.local"], tokenDate: SERVICE_DATE } } });
    expect(used.status).toBe("USED");
    expect(used.usedAt).not.toBeNull();
  });

  it("권이 없으면 404 REFRESH_TOKEN_NOT_FOUND 를 반환한다", async () => {
    await setStock(0);
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const opened = await call("/api/v1/daily/open", { method: "POST", token });
    expect(opened.body.data.refreshTicket.status).toBe("NOT_GRANTED");

    const refreshed = await call("/api/v1/recommendations/refresh", { method: "POST", token });

    expect(refreshed.status).toBe(404);
    expect(refreshed.body.error.code).toBe("REFRESH_TOKEN_NOT_FOUND");
  });

  it("보여줄 새 후보가 없으면 빈 묶음을 주고 권을 쓰지 않는다", async () => {
    await setStock(5);
    freeze();
    const userId = ids["demo@kkagung.local"];
    const token = tokenFor(userId);
    await call("/api/v1/daily/open", { method: "POST", token });

    // 기본 묶음이 이미 모든 후보를 쓴 상태로 만든다.
    const candidates = await db.user.count({
      where: { id: { not: userId }, status: { in: ["ACTIVE", "CHAT_RESTRICTED"] }, profile: { isNot: null }, preference: { isNot: null } },
    });
    expect(candidates).toBeGreaterThan(0);

    let refreshed = await call("/api/v1/recommendations/refresh", { method: "POST", token });
    // 후보가 남아 있으면 소진될 때까지 새로고침권을 다시 채워가며 비운다.
    while (refreshed.status === 200 && refreshed.body.data.cards.length > 0) {
      await db.refreshToken.updateMany({ where: { userId, tokenDate: SERVICE_DATE }, data: { status: "AVAILABLE", usedAt: null } });
      refreshed = await call("/api/v1/recommendations/refresh", { method: "POST", token });
    }

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.cards).toEqual([]);
    expect(refreshed.body.data.refreshTicket.status).toBe("AVAILABLE");
    expect(refreshed.body.data.refreshTicket.usedAt).toBeNull();

    const ticket = await db.refreshToken.findUniqueOrThrow({ where: { userId_tokenDate: { userId, tokenDate: SERVICE_DATE } } });
    expect(ticket.status).toBe("AVAILABLE");
    expect(ticket.usedAt).toBeNull();
  });

  it("새 묶음은 기본 묶음과 겹치지 않고 금지 필드가 없다", async () => {
    await setStock(5);
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const opened = await call("/api/v1/daily/open", { method: "POST", token });
    const refreshed = await call("/api/v1/recommendations/refresh", { method: "POST", token });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.sourceType).toBe("REFRESH");
    const initialIds = new Set(opened.body.data.cards.map((card: { userId: string }) => card.userId));
    for (const card of refreshed.body.data.cards) expect(initialIds.has(card.userId)).toBe(false);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "ORIGINAL_PRIVATE"]) {
      expect(refreshed.text).not.toContain(forbidden);
    }
    expect(Object.keys(refreshed.body.data).sort()).toEqual(["cards", "refreshTicket", "serviceDate", "sourceType"]);
  });
});
