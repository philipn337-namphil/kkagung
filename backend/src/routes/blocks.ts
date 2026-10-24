import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { decodeCursor, encodeCursor, parseLimit } from "./hearts.js";

const UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN"] as const;
const WITHDRAWN_LABEL = "탈퇴한 사용자";

const blockSchema = z.object({ targetUserId: z.string().regex(/^\d+$/) });

export const blocksRouter = Router();

blocksRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const blockerId = req.auth!.userId;
    const limit = parseLimit(req.query.limit);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

    const rows = await prisma.block.findMany({
      where: { blockerId, ...(cursorId === null ? {} : { id: { lt: cursorId } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, targetUserId: true, createdAt: true, target: { select: { status: true, profile: { select: { displayName: true } } } } },
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    // 목록에는 이름과 차단 시각만 담는다. 공개 이미지도 넣지 않는다.
    const items = page.map((row) => ({
      targetUserId: row.targetUserId.toString(),
      displayName: row.target.status === "WITHDRAWN" ? WITHDRAWN_LABEL : row.target.profile?.displayName ?? WITHDRAWN_LABEL,
      blockedAt: row.createdAt,
    }));

    const last = page[page.length - 1];
    return ok(res, { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore });
  } catch (error) { next(error); }
});

blocksRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const blockerId = req.auth!.userId;
    const input = blockSchema.parse(req.body);
    const targetUserId = BigInt(input.targetUserId);
    if (targetUserId === blockerId) return fail(res, 400, "SELF_ACTION_NOT_ALLOWED", "자신은 차단할 수 없습니다.");

    const me = await prisma.user.findUnique({ where: { id: blockerId }, select: { status: true } });
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) return fail(res, 404, "RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다.");

    const existing = await prisma.block.findUnique({ where: { blockerId_targetUserId: { blockerId, targetUserId } }, select: { createdAt: true } });
    if (existing) return ok(res, { targetUserId: targetUserId.toString(), blocked: true, blockedAt: existing.createdAt }, 201);

    try {
      const created = await prisma.block.create({ data: { blockerId, targetUserId }, select: { createdAt: true } });
      return ok(res, { targetUserId: targetUserId.toString(), blocked: true, blockedAt: created.createdAt }, 201);
    } catch (error) {
      // 같은 순간의 다른 요청이 먼저 만들었다면 그 행을 그대로 돌려준다.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const row = await prisma.block.findUniqueOrThrow({ where: { blockerId_targetUserId: { blockerId, targetUserId } }, select: { createdAt: true } });
      return ok(res, { targetUserId: targetUserId.toString(), blocked: true, blockedAt: row.createdAt }, 201);
    }
  } catch (error) { next(error); }
});

blocksRouter.delete("/:targetUserId", requireAuth, async (req, res, next) => {
  try {
    const blockerId = req.auth!.userId;
    const raw = String(req.params.targetUserId);
    if (!/^\d+$/.test(raw)) return fail(res, 404, "BLOCK_NOT_FOUND", "해제할 차단이 없습니다.");
    const targetUserId = BigInt(raw);

    const removed = await prisma.block.deleteMany({ where: { blockerId, targetUserId } });
    if (removed.count === 0) return fail(res, 404, "BLOCK_NOT_FOUND", "해제할 차단이 없습니다.");
    return ok(res, { targetUserId: targetUserId.toString(), blocked: false });
  } catch (error) { next(error); }
});
