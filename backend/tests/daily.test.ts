import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// 시드 계정을 읽고 운세 행만 만든다. users·profiles·images 등 시드 데이터는 건드리지 않고,
// 테스트가 새로 만든 daily_fortunes 행만 끝에서 지운다.
const SEED_EMAILS = ["demo@kkagung.local", "user1@kkagung.local", "user2@kkagung.local", "suspended@kkagung.local"];

// KST 2026-10-27 07:59 = UTC 2026-10-26T22:59Z (서비스 날짜는 전날 2026-10-26)
const BEFORE_EIGHT_UTC = "2026-10-26T22:59:00.000Z";
// KST 2026-10-27 08:00 = UTC 2026-10-26T23:00Z (서비스 날짜는 당일 2026-10-27)
const AT_EIGHT_UTC = "2026-10-26T23:00:00.000Z";

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let ids: Record<string, bigint> = {};
let preexistingFortuneIds: bigint[] = [];

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;

const tokenFor = (userId: bigint, role: "USER" | "ADMIN" = "USER") =>
  jwt.sign({ sub: userId.toString(), role }, jwtSecret, { expiresIn: "12h" });

const call = async (path: string, options: { method?: "GET" | "POST"; token?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
};

const freezeAt = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  jwtSecret = (await import("../src/config.js")).config.jwtSecret;
  db = await loadPrisma();

  const users = await db.user.findMany({ where: { email: { in: SEED_EMAILS } }, select: { id: true, email: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  expect(Object.keys(ids)).toHaveLength(SEED_EMAILS.length);

  preexistingFortuneIds = (await db.dailyFortune.findMany({ select: { id: true } })).map((row) => row.id);

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

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await db.dailyFortune.deleteMany({ where: { userId: { in: Object.values(ids) }, id: { notIn: preexistingFortuneIds } } });
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await db.$disconnect();
});

describe("서비스 날짜", () => {
  it("KST 오전 8시 이전 요청은 전날 서비스 날짜를 쓴다", async () => {
    freezeAt(BEFORE_EIGHT_UTC);
    const { status, body } = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(status).toBe(200);
    expect(body.data.serviceDate).toBe("2026-10-26");
  });

  it("KST 오전 8시 정각 요청은 당일 서비스 날짜를 쓴다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const { status, body } = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(status).toBe(200);
    expect(body.data.serviceDate).toBe("2026-10-27");
  });
});

describe("POST /api/v1/daily/open", () => {
  it("같은 사용자의 같은 날 두 번 조회는 같은 운세를 준다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const token = tokenFor(ids["user1@kkagung.local"]);
    const first = await call("/api/v1/daily/open", { method: "POST", token });
    const second = await call("/api/v1/daily/open", { method: "POST", token });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.fortune).toEqual(first.body.data.fortune);
    expect(first.body.data.firstOpen).toBe(true);
    expect(second.body.data.firstOpen).toBe(false);
  });

  it("시간이 지나 다시 열어도 openedAt 은 최초 값을 유지한다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const token = tokenFor(ids["user1@kkagung.local"]);
    const first = await call("/api/v1/daily/open", { method: "POST", token });

    vi.setSystemTime(new Date(new Date(AT_EIGHT_UTC).getTime() + 60_000));
    const second = await call("/api/v1/daily/open", { method: "POST", token });

    expect(second.body.data.fortune.openedAt).toBe(first.body.data.fortune.openedAt);
  });

  it("동시에 5번 호출해도 오류 없이 같은 운세이고 행은 1개만 생긴다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const userId = ids["user2@kkagung.local"];
    const token = tokenFor(userId);
    const results = await Promise.all(Array.from({ length: 5 }, () => call("/api/v1/daily/open", { method: "POST", token })));

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body.data.fortune).toEqual(results[0].body.data.fortune);
    }
    const rows = await db.dailyFortune.count({ where: { userId, fortuneDate: new Date("2026-10-27T00:00:00Z") } });
    expect(rows).toBe(1);
  });

  it("응답에는 명세서에 있는 필드만 담긴다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const { text, body } = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids["demo@kkagung.local"]) });

    expect(Object.keys(body.data).sort()).toEqual(["cards", "firstOpen", "fortune", "refreshTicket", "serviceDate"]);
    expect(Object.keys(body.data.fortune).sort()).toEqual(["cardCount", "grade", "message", "openedAt", "score"]);
    expect(Object.keys(body.data.refreshTicket).sort()).toEqual(["expiresAt", "granted", "status"]);
    expect(text).not.toContain("password");
    expect(text).not.toContain("@kkagung.local");
  });
});

describe("접근 제한", () => {
  it("토큰이 없으면 401 UNAUTHORIZED 를 반환한다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const { status, body } = await call("/api/v1/daily/open", { method: "POST" });

    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("정지된 계정은 403 SUSPENDED_USER 를 반환한다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const { status, body } = await call("/api/v1/daily/open", { method: "POST", token: tokenFor(ids["suspended@kkagung.local"]) });

    expect(status).toBe(403);
    expect(body.error.code).toBe("SUSPENDED_USER");
  });
});

describe("GET /api/v1/daily", () => {
  it("운세를 열기 전에는 404 RESOURCE_NOT_FOUND 를 반환한다", async () => {
    freezeAt(BEFORE_EIGHT_UTC);
    const { status, body } = await call("/api/v1/daily", { token: tokenFor(ids["user2@kkagung.local"]) });

    expect(status).toBe(404);
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("열고 나면 같은 운세를 cards·firstOpen 없이 반환한다", async () => {
    freezeAt(AT_EIGHT_UTC);
    const token = tokenFor(ids["demo@kkagung.local"]);
    const opened = await call("/api/v1/daily/open", { method: "POST", token });
    const read = await call("/api/v1/daily", { token });

    expect(read.status).toBe(200);
    expect(read.body.data.fortune).toEqual(opened.body.data.fortune);
    expect(Object.keys(read.body.data).sort()).toEqual(["fortune", "refreshTicket", "serviceDate"]);
  });
});
