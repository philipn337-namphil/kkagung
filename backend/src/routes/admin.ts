import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin, writeAuditLog } from "../lib/admin.js";
import { fortuneDateOf, serviceDateOf } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { decodeCursor, encodeCursor, parseLimit } from "./hearts.js";

const SETTING_BADGE_HEARTS = "BADGE_POPULAR_MIN_UNIQUE_HEARTS";
const SETTING_BADGE_REQUESTS = "BADGE_POPULAR_MIN_UNIQUE_CHAT_REQUESTS";
const SETTING_BADGE_WINDOW = "BADGE_POPULAR_WINDOW_DAYS";
const SETTING_DAILY_REFRESH_TOTAL = "DAILY_REFRESH_TOTAL";
const BADGE_DEFAULTS = { popularMinUniqueHearts: 10, popularMinUniqueChatRequests: 5, windowDays: 30 };
const DEFAULT_REFRESH_TOTAL = 100;

const serviceDateQuery = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const sanctionSchema = z.object({
  status: z.enum(["ACTIVE", "RECOMMENDATION_BLOCKED", "CHAT_RESTRICTED", "SUSPENDED"]),
  reason: z.string().min(1).max(200),
});
const reportHandleSchema = z.object({
  status: z.enum(["REVIEWING", "RESOLVED", "DISMISSED"]),
  resultNote: z.string().min(1).max(500),
});
const badgeSchema = z.object({
  popularMinUniqueHearts: z.number().int().min(1).max(1000),
  popularMinUniqueChatRequests: z.number().int().min(1).max(1000),
  windowDays: z.number().int().min(7).max(90).optional(),
});
const dailyRefreshSchema = z.object({ nextTotal: z.number().int().min(0).max(10000) });

const nextServiceDate = (serviceDate: string) => {
  const next = new Date(`${serviceDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};

/** 설정은 적용 일자 이력으로 쌓인다. 해당 날짜까지 유효한 가장 최근 값을 읽는다. */
const readSetting = async (settingKey: string, serviceDate: string) => {
  const row = await prisma.adminSetting.findFirst({
    where: { settingKey, effectiveServiceDate: { lte: fortuneDateOf(serviceDate) } },
    orderBy: { effectiveServiceDate: "desc" },
    select: { settingValue: true },
  });
  return row?.settingValue ?? null;
};

const numberOrDefault = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/dashboard", async (req, res, next) => {
  try {
    const parsed = serviceDateQuery.safeParse(req.query.serviceDate);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "날짜 형식이 올바르지 않습니다.");
    const serviceDate = parsed.data ?? serviceDateOf(new Date());
    const dateValue = fortuneDateOf(serviceDate);
    const dayStart = new Date(`${serviceDate}T00:00:00Z`);
    const dayEnd = new Date(`${nextServiceDate(serviceDate)}T00:00:00Z`);
    const window = { gte: dayStart, lt: dayEnd };

    const [signups, fortuneOpens, cardViews, hearts, chatRequests, chatRoomsCreated, reportsPending, inventory] = await Promise.all([
      prisma.user.count({ where: { createdAt: window } }),
      prisma.dailyFortune.count({ where: { fortuneDate: dateValue, openedAt: { not: null } } }),
      prisma.recommendationItem.count({ where: { recommendationDate: dateValue } }),
      prisma.heart.count({ where: { createdAt: window, canceledAt: null } }),
      prisma.chatRequest.count({ where: { serviceDate: dateValue } }),
      prisma.chatRoom.count({ where: { createdAt: window } }),
      prisma.report.count({ where: { status: "PENDING" } }),
      prisma.dailyRefreshInventory.findUnique({ where: { serviceDate: dateValue }, select: { totalCount: true, remainingCount: true, grantedCount: true } }),
    ]);

    return ok(res, {
      serviceDate,
      signups,
      fortuneOpens,
      cardViews,
      hearts,
      chatRequests,
      chatRoomsCreated,
      reportsPending,
      refreshInventory: inventory === null
        ? { total: 0, remaining: 0, grantedCount: 0 }
        : { total: inventory.totalCount, remaining: inventory.remainingCount, grantedCount: inventory.grantedCount },
    });
  } catch (error) { next(error); }
});

adminRouter.get("/users", async (req, res, next) => {
  try {
    const statusFilter = z.enum(["ACTIVE", "RECOMMENDATION_BLOCKED", "CHAT_RESTRICTED", "SUSPENDED", "WITHDRAWN"]).optional()
      .safeParse(req.query.status === undefined ? undefined : String(req.query.status));
    if (!statusFilter.success) return fail(res, 400, "VALIDATION_ERROR", "상태 값이 올바르지 않습니다.");
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = parseLimit(req.query.limit);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

    const rows = await prisma.user.findMany({
      where: {
        ...(statusFilter.data === undefined ? {} : { status: statusFilter.data }),
        ...(search === "" ? {} : { OR: [{ email: { contains: search } }, { profile: { displayName: { contains: search } } }] }),
        ...(cursorId === null ? {} : { id: { lt: cursorId } }),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: {
        id: true, email: true, role: true, status: true, createdAt: true, lastActiveAt: true,
        profile: { select: { displayName: true } },
      },
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const reportCounts = await prisma.report.groupBy({
      by: ["targetId"],
      where: { targetType: "USER", targetId: { in: page.map((row) => row.id) } },
      _count: { _all: true },
    });
    const countByUserId = new Map(reportCounts.map((entry) => [entry.targetId.toString(), entry._count._all]));

    // 관리 목적에 필요한 최소 필드만 담는다. 비밀번호 해시·사진 정보는 넣지 않는다.
    const items = page.map((row) => ({
      userId: row.id.toString(),
      email: row.email,
      role: row.role,
      status: row.status,
      displayName: row.profile?.displayName ?? null,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      reportCount: countByUserId.get(row.id.toString()) ?? 0,
    }));

    const last = page[page.length - 1];
    return ok(res, { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore });
  } catch (error) { next(error); }
});

adminRouter.patch("/users/:userId/sanction", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const input = sanctionSchema.parse(req.body);
    const raw = String(req.params.userId);
    if (!/^\d+$/.test(raw)) return fail(res, 404, "RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다.");
    const userId = BigInt(raw);

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!target) return fail(res, 404, "RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다.");
    // 탈퇴는 본인만 할 수 있으므로 관리자가 되돌리거나 지정할 수 없다.
    if (target.status === "WITHDRAWN") return fail(res, 400, "VALIDATION_ERROR", "탈퇴한 계정의 상태는 바꿀 수 없습니다.");

    const now = new Date();
    // 같은 값으로 다시 호출하면 상태도 그대로이고 감사 로그도 남기지 않는다.
    if (target.status === input.status) {
      return ok(res, { userId: userId.toString(), previousStatus: target.status, status: input.status, changedAt: now, auditLogId: null });
    }

    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({ where: { id: userId, status: target.status }, data: { status: input.status } });
      if (changed.count !== 1) return { conflict: true as const };
      const log = await writeAuditLog(tx, {
        adminId,
        action: "USER_SANCTION",
        targetType: "USER",
        targetId: userId,
        beforeValue: { status: target.status },
        afterValue: { status: input.status, reason: input.reason },
      });
      return { auditLogId: log.id };
    });

    if ("conflict" in result) return fail(res, 409, "CONFLICT", "다른 요청이 먼저 상태를 바꿨습니다.");
    return ok(res, {
      userId: userId.toString(),
      previousStatus: target.status,
      status: input.status,
      changedAt: now,
      auditLogId: result.auditLogId.toString(),
    });
  } catch (error) { next(error); }
});

adminRouter.get("/reports", async (req, res, next) => {
  try {
    const statusFilter = z.enum(["PENDING", "REVIEWING", "RESOLVED", "DISMISSED"]).optional()
      .safeParse(req.query.status === undefined ? undefined : String(req.query.status));
    if (!statusFilter.success) return fail(res, 400, "VALIDATION_ERROR", "상태 값이 올바르지 않습니다.");
    const limit = parseLimit(req.query.limit);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

    const rows = await prisma.report.findMany({
      where: { ...(statusFilter.data === undefined ? {} : { status: statusFilter.data }), ...(cursorId === null ? {} : { id: { lt: cursorId } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: {
        id: true, targetType: true, targetId: true, reasonCode: true, detail: true,
        status: true, reporterId: true, createdAt: true, handledAt: true, resultNote: true,
      },
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const items = page.map((row) => ({
      reportId: row.id.toString(),
      targetType: row.targetType,
      targetId: row.targetId.toString(),
      reasonCode: row.reasonCode,
      detail: row.detail,
      status: row.status,
      reporterUserId: row.reporterId.toString(),
      createdAt: row.createdAt,
      handledAt: row.handledAt,
      resultNote: row.resultNote,
    }));

    const last = page[page.length - 1];
    return ok(res, { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore });
  } catch (error) { next(error); }
});

adminRouter.patch("/reports/:reportId", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const input = reportHandleSchema.parse(req.body);
    const raw = String(req.params.reportId);
    if (!/^\d+$/.test(raw)) return fail(res, 404, "RESOURCE_NOT_FOUND", "신고를 찾을 수 없습니다.");
    const reportId = BigInt(raw);

    const current = await prisma.report.findUnique({ where: { id: reportId }, select: { status: true } });
    if (!current) return fail(res, 404, "RESOURCE_NOT_FOUND", "신고를 찾을 수 없습니다.");

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.report.updateMany({
        where: { id: reportId, status: current.status },
        data: { status: input.status, resultNote: input.resultNote, handledByAdminId: adminId, handledAt: now },
      });
      if (changed.count !== 1) return { conflict: true as const };
      const log = await writeAuditLog(tx, {
        adminId,
        action: "REPORT_HANDLE",
        targetType: "REPORT",
        targetId: reportId,
        beforeValue: { status: current.status },
        afterValue: { status: input.status },
      });
      const row = await tx.report.findUniqueOrThrow({
        where: { id: reportId },
        select: {
          id: true, targetType: true, targetId: true, reasonCode: true, detail: true,
          status: true, reporterId: true, createdAt: true, handledAt: true, resultNote: true,
        },
      });
      return { row, auditLogId: log.id };
    });

    if ("conflict" in result) return fail(res, 409, "CONFLICT", "다른 요청이 먼저 처리했습니다.");
    return ok(res, {
      reportId: result.row.id.toString(),
      targetType: result.row.targetType,
      targetId: result.row.targetId.toString(),
      reasonCode: result.row.reasonCode,
      detail: result.row.detail,
      status: result.row.status,
      reporterUserId: result.row.reporterId.toString(),
      createdAt: result.row.createdAt,
      handledAt: result.row.handledAt,
      resultNote: result.row.resultNote,
      auditLogId: result.auditLogId.toString(),
    });
  } catch (error) { next(error); }
});

adminRouter.get("/settings", async (_req, res, next) => {
  try {
    const serviceDate = serviceDateOf(new Date());
    const next = nextServiceDate(serviceDate);
    const [hearts, requests, windowDays, currentTotal, nextTotal, inventory] = await Promise.all([
      readSetting(SETTING_BADGE_HEARTS, serviceDate),
      readSetting(SETTING_BADGE_REQUESTS, serviceDate),
      readSetting(SETTING_BADGE_WINDOW, serviceDate),
      readSetting(SETTING_DAILY_REFRESH_TOTAL, serviceDate),
      readSetting(SETTING_DAILY_REFRESH_TOTAL, next),
      prisma.dailyRefreshInventory.findUnique({ where: { serviceDate: fortuneDateOf(serviceDate) }, select: { totalCount: true, remainingCount: true } }),
    ]);

    return ok(res, {
      badge: {
        popularMinUniqueHearts: numberOrDefault(hearts, BADGE_DEFAULTS.popularMinUniqueHearts),
        popularMinUniqueChatRequests: numberOrDefault(requests, BADGE_DEFAULTS.popularMinUniqueChatRequests),
        windowDays: numberOrDefault(windowDays, BADGE_DEFAULTS.windowDays),
      },
      dailyRefresh: {
        currentServiceDate: serviceDate,
        currentTotal: inventory?.totalCount ?? numberOrDefault(currentTotal, DEFAULT_REFRESH_TOTAL),
        currentRemaining: inventory?.remainingCount ?? 0,
        nextServiceDate: next,
        nextTotal: numberOrDefault(nextTotal, numberOrDefault(currentTotal, DEFAULT_REFRESH_TOTAL)),
      },
    });
  } catch (error) { next(error); }
});

adminRouter.put("/settings/badge", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const parsed = badgeSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "SETTING_NOT_ALLOWED", "허용 범위를 벗어난 값입니다.");
    const input = parsed.data;
    const windowDays = input.windowDays ?? BADGE_DEFAULTS.windowDays;

    const serviceDate = serviceDateOf(new Date());
    const effectiveServiceDate = fortuneDateOf(serviceDate);

    const result = await prisma.$transaction(async (tx) => {
      for (const [settingKey, settingValue] of [
        [SETTING_BADGE_HEARTS, input.popularMinUniqueHearts],
        [SETTING_BADGE_REQUESTS, input.popularMinUniqueChatRequests],
        [SETTING_BADGE_WINDOW, windowDays],
      ] as [string, number][]) {
        await tx.adminSetting.upsert({
          where: { settingKey_effectiveServiceDate: { settingKey, effectiveServiceDate } },
          update: { settingValue, updatedByAdminId: adminId },
          create: { settingKey, effectiveServiceDate, settingValue, updatedByAdminId: adminId },
        });
      }
      const log = await writeAuditLog(tx, {
        adminId,
        action: "SETTING_BADGE",
        targetType: "SETTING",
        targetId: BigInt(0),
        afterValue: { popularMinUniqueHearts: input.popularMinUniqueHearts, popularMinUniqueChatRequests: input.popularMinUniqueChatRequests, windowDays },
      });
      return { auditLogId: log.id };
    });

    return ok(res, {
      popularMinUniqueHearts: input.popularMinUniqueHearts,
      popularMinUniqueChatRequests: input.popularMinUniqueChatRequests,
      windowDays,
      auditLogId: result.auditLogId.toString(),
    });
  } catch (error) { next(error); }
});

adminRouter.put("/settings/daily-refresh", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const parsed = dailyRefreshSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "SETTING_NOT_ALLOWED", "허용 범위를 벗어난 값입니다.");

    // 적용 일자는 서버가 정한다. 다음 서비스 날짜부터이며 당일 재고는 다시 채우지 않는다.
    const next = nextServiceDate(serviceDateOf(new Date()));
    const effectiveServiceDate = fortuneDateOf(next);

    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.adminSetting.findUnique({
        where: { settingKey_effectiveServiceDate: { settingKey: SETTING_DAILY_REFRESH_TOTAL, effectiveServiceDate } },
        select: { settingValue: true },
      });
      await tx.adminSetting.upsert({
        where: { settingKey_effectiveServiceDate: { settingKey: SETTING_DAILY_REFRESH_TOTAL, effectiveServiceDate } },
        update: { settingValue: parsed.data.nextTotal, updatedByAdminId: adminId },
        create: { settingKey: SETTING_DAILY_REFRESH_TOTAL, effectiveServiceDate, settingValue: parsed.data.nextTotal, updatedByAdminId: adminId },
      });
      const log = await writeAuditLog(tx, {
        adminId,
        action: "SETTING_DAILY_REFRESH",
        targetType: "SETTING",
        targetId: BigInt(0),
        beforeValue: before === null ? undefined : { nextTotal: before.settingValue as number },
        afterValue: { nextServiceDate: next, nextTotal: parsed.data.nextTotal },
      });
      return { auditLogId: log.id };
    });

    return ok(res, { nextServiceDate: next, nextTotal: parsed.data.nextTotal, auditLogId: result.auditLogId.toString() });
  } catch (error) { next(error); }
});

adminRouter.get("/statistics/daily", async (req, res, next) => {
  try {
    const range = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .safeParse({ from: req.query.from, to: req.query.to });
    if (!range.success) return fail(res, 400, "VALIDATION_ERROR", "기간 형식이 올바르지 않습니다.");
    const from = new Date(`${range.data.from}T00:00:00Z`);
    const to = new Date(`${range.data.to}T00:00:00Z`);
    const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days < 1 || days > 90) return fail(res, 400, "VALIDATION_ERROR", "기간은 1일 이상 90일 이하여야 합니다.");

    const items = [];
    for (let offset = 0; offset < days; offset += 1) {
      const dayStart = new Date(from.getTime() + offset * 86_400_000);
      const serviceDate = dayStart.toISOString().slice(0, 10);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const window = { gte: dayStart, lt: dayEnd };
      const [signups, fortuneOpens, hearts, chatRequests, chatRoomsCreated, reports, inventory] = await Promise.all([
        prisma.user.count({ where: { createdAt: window } }),
        prisma.dailyFortune.count({ where: { fortuneDate: dayStart, openedAt: { not: null } } }),
        prisma.heart.count({ where: { createdAt: window, canceledAt: null } }),
        prisma.chatRequest.count({ where: { serviceDate: dayStart } }),
        prisma.chatRoom.count({ where: { createdAt: window } }),
        prisma.report.count({ where: { createdAt: window } }),
        prisma.dailyRefreshInventory.findUnique({ where: { serviceDate: dayStart }, select: { grantedCount: true } }),
      ]);
      items.push({ serviceDate, signups, fortuneOpens, hearts, chatRequests, chatRoomsCreated, reports, refreshGranted: inventory?.grantedCount ?? 0 });
    }

    return ok(res, { items });
  } catch (error) { next(error); }
});
