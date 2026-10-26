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
let jwtIssuer = "";
let jwtAudience = "";
let ids: Record<string, bigint> = {};
let seedStatus: Map<string, string> = new Map();

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint, role: "USER" | "ADMIN") => jwt.sign({ role }, jwtSecret, { subject: userId.toString(), expiresIn: "12h", issuer: jwtIssuer, audience: jwtAudience, jwtid: crypto.randomUUID() });

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
  const appConfig = (await import("../src/config.js")).config; jwtSecret = appConfig.jwtSecret; jwtIssuer = appConfig.jwtIssuer; jwtAudience = appConfig.jwtAudience;
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

  // 제재 상태는 서로 되돌릴 수 있는 값이라 "동시에 오면 한 번만 반영" 이라는 기준을 세울 수 없다.
  // 두 요청이 같은 값을 읽었으면 한쪽이 409 로 밀리고, 한쪽이 먼저 반영된 뒤 다른 쪽이 읽었으면
  // 두 제재가 순서대로 적용된다. 둘 다 정상 동작이고 어느 쪽인지는 타이밍이 정한다.
  // 그래서 성공 횟수가 아니라, 상태가 겹쳐 쓰이지 않고 감사 로그가 적용된 변경과 정확히 일치하는지를 본다.
  it("동시에 두 번 바꿔도 상태가 겹쳐 쓰이지 않고 감사 로그가 변경과 일치한다", async () => {
    freeze();
    const targetId = ids["user1@kkagung.local"];
    try {
      const results = await Promise.all([
        call(`/api/v1/admin/users/${targetId}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "SUSPENDED", reason: "동시 1" } }),
        call(`/api/v1/admin/users/${targetId}/sanction`, { method: "PATCH", token: adminToken(), body: { status: "RECOMMENDATION_BLOCKED", reason: "동시 2" } }),
      ]);

      // 밀린 요청은 409 여야 한다. 500 이나 그 밖의 코드로 새면 안 된다.
      const applied = results.filter((result) => result.status === 200);
      expect(applied.length).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (result.status !== 200) expect(result.status).toBe(409);
        else expect(["SUSPENDED", "RECOMMENDATION_BLOCKED"]).toContain(result.body.data.status);
      }

      // 감사 로그는 적용된 변경 수와 같아야 한다. 하나라도 비거나 중복되면 실패다.
      const logs = await db.adminAuditLog.findMany({
        where: { action: "USER_SANCTION", targetId },
        orderBy: { id: "asc" },
        select: { beforeValue: true, afterValue: true },
      });
      expect(logs).toHaveLength(applied.length);

      // ACTIVE 에서 시작해 before/after 가 끊기지 않고 이어지고, 마지막 값이 실제 상태와 같아야 한다.
      // 중간에 끊기면 두 변경이 서로를 덮어썼다는 뜻이다.
      let expectedBefore = "ACTIVE";
      for (const log of logs) {
        expect((log.beforeValue as { status: string }).status).toBe(expectedBefore);
        expectedBefore = (log.afterValue as { status: string }).status;
      }
      const stored = await db.user.findUniqueOrThrow({ where: { id: targetId }, select: { status: true } });
      expect(stored.status).toBe(expectedBefore);
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

  it("이미 처리된 신고를 다시 처리하면 409 이고 결론이 바뀌지 않는다", async () => {
    freeze();
    const report = await makeReport();

    const first = await call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "RESOLVED", resultNote: "1차 처리" } });
    expect(first.status).toBe(200);

    const again = await call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "DISMISSED", resultNote: "결론 덮어쓰기" } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");

    const stored = await db.report.findUniqueOrThrow({ where: { id: report.id }, select: { status: true, resultNote: true } });
    expect(stored.status).toBe("RESOLVED");
    expect(stored.resultNote).toBe("1차 처리");
    expect(await db.adminAuditLog.count({ where: { action: "REPORT_HANDLE", targetId: report.id } })).toBe(1);
  });

  // 신고는 한 번 결론이 나면 종결이므로 제재와 달리 "한 번만 반영" 이 성립한다.
  // 두 요청이 모두 PENDING 을 읽으면 조건부 UPDATE 가 한쪽을 밀어내고,
  // 한쪽이 먼저 종결시킨 뒤 다른 쪽이 읽으면 종결 상태 가드가 막는다. 어느 순서든 결과가 같다.
  it("동시에 두 번 처리하면 한 번만 반영된다", async () => {
    freeze();
    const report = await makeReport();

    const results = await Promise.all([
      call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "RESOLVED", resultNote: "동시 1" } }),
      call(`/api/v1/admin/reports/${report.id}`, { method: "PATCH", token: adminToken(), body: { status: "DISMISSED", resultNote: "동시 2" } }),
    ]);

    for (const result of results) {
      if (result.status !== 200) expect(result.status, `밀린 요청 응답: ${result.text}`).toBe(409);
    }
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(await db.adminAuditLog.count({ where: { action: "REPORT_HANDLE", targetId: report.id } })).toBe(1);

    // 남은 결론은 이긴 요청의 것이어야 한다.
    const winner = results.find((result) => result.status === 200)!;
    const stored = await db.report.findUniqueOrThrow({ where: { id: report.id }, select: { status: true } });
    expect(stored.status).toBe(winner.body.data.status);
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
