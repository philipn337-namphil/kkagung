import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

const EMAILS = ["admin@kkagung.local", "demo@kkagung.local", "user1@kkagung.local", "user4@kkagung.local"];

// KST 2030-01-15 09:00 = UTC 2030-01-15T00:00Z → 서비스 날짜 2030-01-15
const FROZEN_UTC = "2030-01-15T00:00:00.000Z";
const SERVICE_DATE_TEXT = "2030-01-15";
const SERVICE_DATE = new Date(`${SERVICE_DATE_TEXT}T00:00:00Z`);
const NEXT_SERVICE_DATE = new Date("2030-01-16T00:00:00Z");

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let ids: Record<string, bigint> = {};
let seedStatus: Map<string, string> = new Map();

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint, role: "USER" | "ADMIN") => jwt.sign({ sub: userId.toString(), role }, jwtSecret, { expiresIn: "12h" });

const call = async (path: string, options: { method?: "GET" | "POST" | "PATCH" | "PUT"; token?: string; body?: unknown } = {}) => {
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

const adminToken = () => tokenFor(ids["admin@kkagung.local"], "ADMIN");

const clearOwnRows = async () => {
  const seedIds = Object.values(ids);
  await db.adminAuditLog.deleteMany({ where: { adminId: { in: seedIds } } });
  await db.adminSetting.deleteMany({ where: { effectiveServiceDate: { in: [SERVICE_DATE, NEXT_SERVICE_DATE] } } });
  await db.report.deleteMany({ where: { reporterId: { in: seedIds } } });
  await db.dailyRefreshInventory.deleteMany({ where: { serviceDate: { in: [SERVICE_DATE, NEXT_SERVICE_DATE] } } });
  await db.dailyFortune.deleteMany({ where: { userId: { in: seedIds }, fortuneDate: SERVICE_DATE } });
  await db.recommendationItem.deleteMany({ where: { viewerId: { in: seedIds }, recommendationDate: SERVICE_DATE } });
};

/** 시드 계정의 상태를 원래대로 돌린다. */
const restoreSeedStatus = async () => {
  for (const [email, status] of seedStatus) {
    await db.user.updateMany({ where: { email }, data: { status: status as "ACTIVE" } });
  }
};

const makeReport = () =>
  db.report.create({
    data: { reporterId: ids["demo@kkagung.local"], targetType: "USER", targetId: ids["user4@kkagung.local"], reasonCode: "ABUSE", detail: "확인 필요" },
    select: { id: true },
  });

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  jwtSecret = (await import("../src/config.js")).config.jwtSecret;
  db = await loadPrisma();

  const users = await db.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true, email: true, status: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  seedStatus = new Map(users.map((user) => [user.email, user.status]));
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
  await restoreSeedStatus();
  await clearOwnRows();
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await db.$disconnect();
});

describe("관리자 권한", () => {
  it("토큰이 없으면 401, 일반 사용자는 403 을 반환한다", async () => {
    freeze();
    for (const path of ["/api/v1/admin/dashboard", "/api/v1/admin/users", "/api/v1/admin/reports", "/api/v1/admin/settings"]) {
      const noToken = await call(path);
      expect(noToken.status).toBe(401);
      expect(noToken.body.error.code).toBe("UNAUTHORIZED");

      const asUser = await call(path, { token: tokenFor(ids["demo@kkagung.local"], "USER") });
      expect(asUser.status).toBe(403);
      expect(asUser.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("토큰에 ADMIN 이라고 적혀 있어도 DB 역할이 일반이면 403 이다", async () => {
    freeze();
    const forged = tokenFor(ids["demo@kkagung.local"], "ADMIN");
    const result = await call("/api/v1/admin/dashboard", { token: forged });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/v1/admin/dashboard", () => {
  it("집계 수치만 반환한다", async () => {
    freeze();
    const result = await call("/api/v1/admin/dashboard", { token: adminToken() });

    expect(result.status).toBe(200);
    expect(Object.keys(result.body.data).sort()).toEqual([
      "cardViews", "chatRequests", "chatRoomsCreated", "fortuneOpens", "hearts",
      "refreshInventory", "reportsPending", "serviceDate", "signups",
    ]);
    expect(result.body.data.serviceDate).toBe(SERVICE_DATE_TEXT);
    expect(Object.keys(result.body.data.refreshInventory).sort()).toEqual(["grantedCount", "remaining", "total"]);
    for (const forbidden of ["password", "objectKey", "object_key", "@kkagung.local"]) expect(result.text).not.toContain(forbidden);
  });
});

describe("GET /api/v1/admin/users", () => {
  it("관리 목적 필드만 담고 비밀번호·사진 정보는 없다", async () => {
    freeze();
    const result = await call("/api/v1/admin/users?limit=5", { token: adminToken() });

    expect(result.status).toBe(200);
    expect(Object.keys(result.body.data).sort()).toEqual(["hasMore", "items", "nextCursor"]);
    expect(Object.keys(result.body.data.items[0]).sort()).toEqual([
      "createdAt", "displayName", "email", "lastActiveAt", "reportCount", "role", "status", "userId",
    ]);
    for (const forbidden of ["password", "objectKey", "object_key", "birthDate"]) expect(result.text).not.toContain(forbidden);
  });

  it("상태로 걸러내고 잘못된 상태는 400 이다", async () => {
    freeze();
    const filtered = await call("/api/v1/admin/users?status=SUSPENDED", { token: adminToken() });
    expect(filtered.status).toBe(200);
    for (const item of filtered.body.data.items) expect(item.status).toBe("SUSPENDED");

    const invalid = await call("/api/v1/admin/users?status=NOPE", { token: adminToken() });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /api/v1/admin/users/:userId/sanction", () => {
  it("상태를 바꾸고 감사 로그를 남긴다", async () => {
    freeze();
    const targetId = ids["user1@kkagung.local"];
    try {
      const result = await call(`/api/v1/admin/users/${targetId}/sanction`, {
        method: "PATCH",
        token: adminToken(),
        body: { status: "CHAT_RESTRICTED", reason: "신고 누적" },
      });

      expect(result.status).toBe(200);
      expect(result.body.data.previousStatus).toBe("ACTIVE");
      expect(result.body.data.status).toBe("CHAT_RESTRICTED");
      expect(typeof result.body.data.auditLogId).toBe("string");

      const log = await db.adminAuditLog.findFirstOrThrow({ where: { action: "USER_SANCTION", targetId }, orderBy: { id: "desc" } });
      expect(log.result).toBe("SUCCESS");
      expect(log.adminId).toBe(ids["admin@kkagung.local"]);
    } finally {
      await db.user.update({ where: { id: targetId }, data: { status: "ACTIVE" } });
    }
  });

  it("같은 값으로 다시 호출하면 감사 로그가 늘지 않는다", async () => {
    freeze();
    const targetId = ids["user1@kkagung.local"];
    try {
      await call(`/api/v1/admin/users/${targetId}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "CHAT_RESTRICTED", reason: "첫 제재" } });
      const logsAfterFirst = await db.adminAuditLog.count({ where: { action: "USER_SANCTION", targetId } });

      const again = await call(`/api/v1/admin/users/${targetId}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "CHAT_RESTRICTED", reason: "같은 제재" } });
      expect(again.status).toBe(200);
      expect(again.body.data.auditLogId).toBeNull();
      expect(await db.adminAuditLog.count({ where: { action: "USER_SANCTION", targetId } })).toBe(logsAfterFirst);
    } finally {
      await db.user.update({ where: { id: targetId }, data: { status: "ACTIVE" } });
    }
  });

  it("동시에 두 번 바꾸면 한 번만 반영된다", async () => {
    freeze();
    const targetId = ids["user1@kkagung.local"];
    try {
      const results = await Promise.all([
        call(`/api/v1/admin/users/${targetId}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "SUSPENDED", reason: "동시 1" } }),
        call(`/api/v1/admin/users/${targetId}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "RECOMMENDATION_BLOCKED", reason: "동시 2" } }),
      ]);

      for (const result of results) expect(result.status).toBeLessThan(500);
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(await db.adminAuditLog.count({ where: { action: "USER_SANCTION", targetId } })).toBe(1);
    } finally {
      await db.user.update({ where: { id: targetId }, data: { status: "ACTIVE" } });
    }
  });

  it("없는 사용자는 404, 잘못된 값은 400 이다", async () => {
    freeze();
    const missing = await call("/api/v1/admin/users/99999999/sanction", { method: "PATCH", token: adminToken(), body: { status: "SUSPENDED", reason: "없음" } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RESOURCE_NOT_FOUND");

    const invalid = await call(`/api/v1/admin/users/${ids["user1@kkagung.local"]}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "WITHDRAWN", reason: "불가" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("신고 처리", () => {
  it("목록을 읽고 처리하면 감사 로그가 남는다", async () => {
    freeze();
    const report = await makeReport();

    const listed = await call("/api/v1/admin/reports?status=PENDING", { token: adminToken() });
    expect(listed.status).toBe(200);
    expect(Object.keys(listed.body.data.items[0]).sort()).toEqual([
      "createdAt", "detail", "handledAt", "reasonCode", "reportId", "reporterUserId", "resultNote", "status", "targetId", "targetType",
    ]);

    const handled = await call(`/api/v1/admin/reports/${report.id}`, {
      method: "PATCH",
      token: adminToken(),
      body: { status: "RESOLVED", resultNote: "경고 처리함" },
    });
    expect(handled.status).toBe(200);
    expect(handled.body.data.status).toBe("RESOLVED");
    expect(typeof handled.body.data.auditLogId).toBe("string");

    const stored = await db.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(stored.handledByAdminId).toBe(ids["admin@kkagung.local"]);
    expect(await db.adminAuditLog.count({ where: { action: "REPORT_HANDLE", targetId: report.id } })).toBe(1);
  });

  it("동시에 두 번 처리하면 한 번만 반영된다", async () => {
    freeze();
    const report = await makeReport();

    const results = await Promise.all([
      call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "RESOLVED", resultNote: "동시 1" } }),
      call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "DISMISSED", resultNote: "동시 2" } }),
    ]);

    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(await db.adminAuditLog.count({ where: { action: "REPORT_HANDLE", targetId: report.id } })).toBe(1);
  });

  it("없는 신고는 404, 잘못된 값은 400 이다", async () => {
    freeze();
    const missing = await call("/api/v1/admin/reports/99999999", { method: "PATCH", token: adminToken(), body: { status: "RESOLVED", resultNote: "없음" } });
    expect(missing.status).toBe(404);

    const report = await makeReport();
    const invalid = await call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "PENDING", resultNote: "되돌리기" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("설정", () => {
  it("배지 기준을 바꾸고 다시 읽으면 반영된다", async () => {
    freeze();
    const changed = await call("/api/v1/admin/settings/badge", {
      method: "PUT",
      token: adminToken(),
      body: { popularMinUniqueHearts: 20, popularMinUniqueChatRequests: 7, windowDays: 14 },
    });

    expect(changed.status).toBe(200);
    expect(changed.body.data.popularMinUniqueHearts).toBe(20);
    expect(typeof changed.body.data.auditLogId).toBe("string");

    const read = await call("/api/v1/admin/settings", { token: adminToken() });
    expect(read.body.data.badge).toEqual({ popularMinUniqueHearts: 20, popularMinUniqueChatRequests: 7, windowDays: 14 });
    expect(await db.adminAuditLog.count({ where: { action: "SETTING_BADGE" } })).toBe(1);
  });

  it("허용 범위를 벗어난 배지 값은 400 SETTING_NOT_ALLOWED 이다", async () => {
    freeze();
    const invalid = await call("/api/v1/admin/settings/badge", {
      method: "PUT",
      token: adminToken(),
      body: { popularMinUniqueHearts: 0, popularMinUniqueChatRequests: 7 },
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("SETTING_NOT_ALLOWED");
  });

  it("선착순 인원은 다음 서비스 날짜부터 적용된다", async () => {
    freeze();
    const changed = await call("/api/v1/admin/settings/daily-refresh", { method: "PUT", token: adminToken(), body: { nextTotal: 150 } });

    expect(changed.status).toBe(200);
    expect(changed.body.data.nextServiceDate).toBe("2030-01-16");
    expect(changed.body.data.nextTotal).toBe(150);

    const read = await call("/api/v1/admin/settings", { token: adminToken() });
    expect(read.body.data.dailyRefresh.nextServiceDate).toBe("2030-01-16");
    expect(read.body.data.dailyRefresh.nextTotal).toBe(150);
    expect(await db.adminAuditLog.count({ where: { action: "SETTING_DAILY_REFRESH" } })).toBe(1);
  });

  it("범위를 벗어난 선착순 인원은 400 이다", async () => {
    freeze();
    const invalid = await call("/api/v1/admin/settings/daily-refresh", { method: "PUT", token: adminToken(), body: { nextTotal: 10001 } });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("SETTING_NOT_ALLOWED");
  });
});

describe("GET /api/v1/admin/statistics/daily", () => {
  it("기간별 집계를 돌려주고 잘못된 기간은 400 이다", async () => {
    freeze();
    const listed = await call("/api/v1/admin/statistics/daily?from=2030-01-13&to=2030-01-15", { token: adminToken() });

    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(3);
    expect(Object.keys(listed.body.data.items[0]).sort()).toEqual([
      "chatRequests", "chatRoomsCreated", "fortuneOpens", "hearts", "refreshGranted", "reports", "serviceDate", "signups",
    ]);

    const reversed = await call("/api/v1/admin/statistics/daily?from=2030-01-15&to=2030-01-13", { token: adminToken() });
    expect(reversed.status).toBe(400);

    const tooLong = await call("/api/v1/admin/statistics/daily?from=2030-01-01&to=2030-06-01", { token: adminToken() });
    expect(tooLong.status).toBe(400);
  });
});
