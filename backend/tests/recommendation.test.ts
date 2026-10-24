import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// 시드 계정은 읽기만 한다. 테스트가 새로 만든 daily_fortunes / recommendation_items / blocks 행만 끝에서 지운다.
const SEED_EMAILS = [
  "admin@kkagung.local",
  "demo@kkagung.local",
  "user1@kkagung.local",
  "user4@kkagung.local",
  "user5@kkagung.local",
  "suspended@kkagung.local",
];

// KST 2026-10-27 09:00 = UTC 2026-10-27T00:00Z (서비스 날짜 2026-10-27)
const FROZEN_UTC = "2026-10-27T00:00:00.000Z";
const SERVICE_DATE = new Date("2026-10-27T00:00:00Z");

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let ids: Record<string, bigint> = {};
let keptFortuneIds: bigint[] = [];
let keptItemIds: bigint[] = [];
const createdBlockIds: bigint[] = [];

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;

const tokenFor = (userId: bigint) => jwt.sign({ sub: userId.toString(), role: "USER" }, jwtSecret, { expiresIn: "12h" });

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

const openFor = (email: string) => call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids[email]) });

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  jwtSecret = (await import("../src/config.js")).config.jwtSecret;
  db = await loadPrisma();

  const users = await db.user.findMany({ where: { email: { in: SEED_EMAILS } }, select: { id: true, email: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  expect(Object.keys(ids)).toHaveLength(SEED_EMAILS.length);

  keptFortuneIds = (await db.dailyFortune.findMany({ select: { id: true } })).map((row) => row.id);
  keptItemIds = (await db.recommendationItem.findMany({ select: { id: true } })).map((row) => row.id);

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

afterEach(async () => {
  vi.useRealTimers();
  // 차단은 케이스마다 넣고 바로 되돌려 다른 케이스에 영향을 주지 않게 한다.
  if (createdBlockIds.length > 0) {
    await db.block.deleteMany({ where: { id: { in: createdBlockIds.splice(0) } } });
  }
});

afterAll(async () => {
  const seedIds = Object.values(ids);
  // 운세를 열면 추천 행과 새로고침권·재고 행도 함께 생긴다. 다른 테스트 파일의 순서나
  // 외래키 CASCADE 에 기대지 않고, 이 테스트가 쓴 서비스 날짜 분을 직접 지운다.
  if (createdBlockIds.length > 0) await db.block.deleteMany({ where: { id: { in: createdBlockIds.splice(0) } } });
  await db.refreshToken.deleteMany({ where: { userId: { in: seedIds }, tokenDate: SERVICE_DATE } });
  await db.dailyRefreshInventory.deleteMany({ where: { serviceDate: SERVICE_DATE } });
  await db.recommendationItem.deleteMany({ where: { viewerId: { in: seedIds }, id: { notIn: keptItemIds } } });
  await db.dailyFortune.deleteMany({ where: { userId: { in: seedIds }, id: { notIn: keptFortuneIds } } });
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await db.$disconnect();
});

describe("추천 후보 조건", () => {
  it("남성 뷰어의 카드는 모두 여성이고 정지 계정은 없다", async () => {
    freeze();
    const { status, body } = await openFor("demo@kkagung.local");

    expect(status).toBe(200);
    expect(body.data.cards.length).toBeGreaterThan(0);
    for (const card of body.data.cards) expect(card.gender).toBe("FEMALE");
    const suspendedId = ids["suspended@kkagung.local"].toString();
    expect(body.data.cards.map((card: { userId: string }) => card.userId)).not.toContain(suspendedId);
  });

  it("여성 뷰어의 카드는 모두 남성이고 본인은 없다", async () => {
    freeze();
    const { status, body } = await openFor("user4@kkagung.local");

    expect(status).toBe(200);
    expect(body.data.cards.length).toBeGreaterThan(0);
    for (const card of body.data.cards) expect(card.gender).toBe("MALE");
    expect(body.data.cards.map((card: { userId: string }) => card.userId)).not.toContain(ids["user4@kkagung.local"].toString());
  });

  it("카드 수는 운세의 cardCount 를 넘지 않는다", async () => {
    freeze();
    const { body } = await openFor("user1@kkagung.local");

    expect(body.data.cards.length).toBeLessThanOrEqual(body.data.fortune.cardCount);
  });
});

describe("같은 날 같은 결과", () => {
  it("재호출과 동시 5회 호출이 같은 카드를 주고 중복 행이 생기지 않는다", async () => {
    freeze();
    const viewerId = ids["user5@kkagung.local"];
    const token = tokenFor(viewerId);
    const first = await call("/api/v1/daily/open", { method: "POST", token });
    const results = await Promise.all(Array.from({ length: 5 }, () => call("/api/v1/daily/open", { method: "POST", token })));

    expect(first.status).toBe(200);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body.data.cards).toEqual(first.body.data.cards);
    }
    const rows = await db.recommendationItem.findMany({ where: { viewerId, recommendationDate: SERVICE_DATE }, select: { targetUserId: true } });
    const unique = new Set(rows.map((row) => row.targetUserId.toString()));
    expect(unique.size).toBe(rows.length);
    expect(rows.length).toBe(first.body.data.cards.length);
  });
});

describe("차단 제외", () => {
  it("내가 차단한 상대는 카드에 나오지 않는다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const before = await openFor("demo@kkagung.local");
    const blockedId = before.body.data.cards[0].userId as string;

    await db.recommendationItem.deleteMany({ where: { viewerId, recommendationDate: SERVICE_DATE } });
    const block = await db.block.create({ data: { blockerId: viewerId, targetUserId: BigInt(blockedId) } });
    createdBlockIds.push(block.id);

    const after = await openFor("demo@kkagung.local");
    expect(after.body.data.cards.map((card: { userId: string }) => card.userId)).not.toContain(blockedId);
  });

  it("상대가 나를 차단한 경우에도 카드에 나오지 않는다", async () => {
    freeze();
    const viewerId = ids["demo@kkagung.local"];
    const before = await openFor("demo@kkagung.local");
    const blockedId = before.body.data.cards[0].userId as string;

    await db.recommendationItem.deleteMany({ where: { viewerId, recommendationDate: SERVICE_DATE } });
    const block = await db.block.create({ data: { blockerId: BigInt(blockedId), targetUserId: viewerId } });
    createdBlockIds.push(block.id);

    const after = await openFor("demo@kkagung.local");
    expect(after.body.data.cards.map((card: { userId: string }) => card.userId)).not.toContain(blockedId);
  });
});

describe("응답 필드", () => {
  it("카드에는 PublicCard 필드만 담기고 금지 필드가 없다", async () => {
    freeze();
    const { text, body } = await openFor("demo@kkagung.local");

    expect(Object.keys(body.data.cards[0]).sort()).toEqual([
      "age", "animalFace", "badges", "displayName", "gender", "heightCm",
      "jobCategory", "mbti", "publicImage", "recommendReason", "regionLabel", "userId",
    ]);
    for (const forbidden of ["email", "@kkagung.local", "birthDate", "objectKey", "object_key", "password", "ORIGINAL_PRIVATE", "intro", "celebrityLookalike"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("공개 이미지 기준 주소가 설정되면 공개 버킷 경로로 URL 을 만든다", async () => {
    freeze();
    const previous = process.env.OBJECT_STORAGE_ENDPOINT;
    process.env.OBJECT_STORAGE_ENDPOINT = "https://storage.example";
    try {
      await db.recommendationItem.deleteMany({ where: { viewerId: ids["demo@kkagung.local"], recommendationDate: SERVICE_DATE } });
      const { body } = await openFor("demo@kkagung.local");
      const image = body.data.cards[0].publicImage;
      expect(image).not.toBeNull();
      expect(["AI_PUBLIC", "BLURRED_PUBLIC"]).toContain(image.type);
      expect(image.url.startsWith("https://storage.example/")).toBe(true);
      expect(image.url).not.toContain("originals/");
    } finally {
      if (previous === undefined) delete process.env.OBJECT_STORAGE_ENDPOINT;
      else process.env.OBJECT_STORAGE_ENDPOINT = previous;
    }
  });
});

describe("GET /api/v1/recommendations/today", () => {
  it("프로필이 없는 계정은 409 PROFILE_INCOMPLETE 를 반환한다", async () => {
    freeze();
    const { status, body } = await call("/api/v1/recommendations/today", { token: tokenFor(ids["admin@kkagung.local"]) });

    expect(status).toBe(409);
    expect(body.error.code).toBe("PROFILE_INCOMPLETE");
  });

  it("운세를 연 뒤에는 같은 카드를 sourceType 과 함께 반환한다", async () => {
    freeze();
    const token = tokenFor(ids["demo@kkagung.local"]);
    const opened = await call("/api/v1/daily/open", { method: "POST", token });
    const listed = await call("/api/v1/recommendations/today", { token });

    expect(listed.status).toBe(200);
    expect(listed.body.data.sourceType).toBe("INITIAL");
    expect(listed.body.data.cards).toEqual(opened.body.data.cards);
    expect(Object.keys(listed.body.data).sort()).toEqual(["cards", "heartedUserIds", "requestedUserIds", "serviceDate", "sourceType"]);
  });
});
