import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { buildPublicCards, fortuneDateOf, serviceDateOf } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

const UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN"] as const;
const TARGET_BLOCKED_STATUS = ["SUSPENDED", "WITHDRAWN", "RECOMMENDATION_BLOCKED"] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// 커서는 불투명한 문자열이다. 마지막으로 읽은 행의 id 만 담는다.
export const encodeCursor = (id: bigint) => Buffer.from(id.toString(), "utf8").toString("base64url");
export const decodeCursor = (cursor: string) => {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(text)) return null;
  return BigInt(text);
};

export const parseLimit = (raw: unknown) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return DEFAULT_LIMIT;
  return value;
};

export const blockedIdsFor = async (userId: bigint) => {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { targetUserId: userId }] },
    select: { blockerId: true, targetUserId: true },
  });
  const ids = new Set<string>();
  for (const block of blocks) {
    ids.add(block.blockerId.toString());
    ids.add(block.targetUserId.toString());
  }
  return ids;
};

// 무시한 사실은 발신자에게 알리지 않는다. 내가 보낸 요청의 IGNORED 는 PENDING 으로 보여준다.
export const senderFacingStatus = (status: string | undefined) => {
  if (status === undefined) return "NONE";
  return status === "IGNORED" ? "PENDING" : status;
};

export const heartsRouter = Router();

heartsRouter.post("/cards/:targetUserId/hearts", requireAuth, async (req, res, next) => {
  try {
    const senderId = req.auth!.userId;
    const raw = String(req.params.targetUserId);
    if (!/^\d+$/.test(raw)) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");
    const receiverId = BigInt(raw);
    if (receiverId === senderId) return fail(res, 400, "SELF_ACTION_NOT_ALLOWED", "자신에게는 보낼 수 없습니다.");

    const me = await prisma.user.findUnique({ where: { id: senderId }, select: { status: true } });
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    const target = await prisma.user.findUnique({ where: { id: receiverId }, select: { status: true } });
    if (!target) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");

    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: senderId, targetUserId: receiverId }, { blockerId: receiverId, targetUserId: senderId }] },
      select: { blockerId: true },
    });
    if (blocks.some((block) => block.blockerId === senderId)) return fail(res, 403, "TARGET_BLOCKED", "차단한 상대입니다.");
    if (blocks.length > 0) return fail(res, 403, "BLOCKED_BY_TARGET", "상대가 차단했습니다.");
    if ((TARGET_BLOCKED_STATUS as readonly string[]).includes(target.status)) return fail(res, 403, "TARGET_UNAVAILABLE", "지금은 보낼 수 없는 상대입니다.");

    // 오늘 나에게 노출된 카드이거나, 나에게 하트를 보낸 사람이어야 한다.
    const serviceDate = serviceDateOf(new Date());
    const shown = await prisma.recommendationItem.count({
      where: { viewerId: senderId, targetUserId: receiverId, recommendationDate: fortuneDateOf(serviceDate) },
    });
    const heartedMe = shown > 0 ? 0 : await prisma.heart.count({ where: { senderId: receiverId, receiverId: senderId, canceledAt: null } });
    if (shown === 0 && heartedMe === 0) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");

    const existing = await prisma.heart.findUnique({ where: { senderId_receiverId: { senderId, receiverId } } });
    if (existing && existing.canceledAt === null) return fail(res, 409, "HEART_ALREADY_SENT", "이미 하트를 보냈습니다.");

    if (existing) {
      // 취소했던 하트는 같은 행을 되살린다.
      const revived = await prisma.heart.updateMany({ where: { id: existing.id, canceledAt: { not: null } }, data: { canceledAt: null } });
      if (revived.count !== 1) return fail(res, 409, "HEART_ALREADY_SENT", "이미 하트를 보냈습니다.");
      const row = await prisma.heart.findUniqueOrThrow({ where: { id: existing.id }, select: { updatedAt: true } });
      return ok(res, { targetUserId: receiverId.toString(), hearted: true, sentAt: row.updatedAt }, 201);
    }

    try {
      const created = await prisma.heart.create({ data: { senderId, receiverId }, select: { updatedAt: true } });
      return ok(res, { targetUserId: receiverId.toString(), hearted: true, sentAt: created.updatedAt }, 201);
    } catch (error) {
      // 같은 순간의 다른 요청이 먼저 만들었다면 유니크 충돌이 난다. 중복 하트로 처리한다.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      return fail(res, 409, "HEART_ALREADY_SENT", "이미 하트를 보냈습니다.");
    }
  } catch (error) { next(error); }
});

heartsRouter.delete("/cards/:targetUserId/hearts", requireAuth, async (req, res, next) => {
  try {
    const senderId = req.auth!.userId;
    const raw = String(req.params.targetUserId);
    if (!/^\d+$/.test(raw)) return fail(res, 404, "HEART_NOT_FOUND", "취소할 하트가 없습니다.");
    const receiverId = BigInt(raw);

    const existing = await prisma.heart.findUnique({ where: { senderId_receiverId: { senderId, receiverId } }, select: { id: true } });
    if (!existing) return fail(res, 404, "HEART_NOT_FOUND", "취소할 하트가 없습니다.");

    // 행은 지우지 않고 취소 시각만 남긴다. 이미 취소된 하트면 그대로 같은 결과를 준다.
    await prisma.heart.updateMany({ where: { id: existing.id, canceledAt: null }, data: { canceledAt: new Date() } });
    return ok(res, { targetUserId: receiverId.toString(), hearted: false });
  } catch (error) { next(error); }
});

heartsRouter.get("/hearts/received", requireAuth, async (req, res, next) => {
  try {
    const receiverId = req.auth!.userId;
    const me = await prisma.user.findUnique({ where: { id: receiverId }, select: { status: true } });
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    const limit = parseLimit(req.query.limit);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

    const excluded = await blockedIdsFor(receiverId);
    const rows = await prisma.heart.findMany({
      where: {
        receiverId,
        canceledAt: null,
        ...(cursorId === null ? {} : { id: { lt: cursorId } }),
        sender: { status: { notIn: [...UNAVAILABLE_STATUS] } },
      },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, senderId: true, createdAt: true, updatedAt: true },
    });

    const visible = rows.filter((row) => !excluded.has(row.senderId.toString()));
    const page = visible.slice(0, limit);
    const hasMore = visible.length > limit;

    const serviceDate = serviceDateOf(new Date());
    const cards = await buildPublicCards(receiverId, serviceDate, page.map((row) => ({ targetUserId: row.senderId, reasonCode: "RECEIVED_HEART" })));
    const cardByUserId = new Map(cards.map((card) => [card.userId, card]));

    const requests = await prisma.chatRequest.findMany({
      where: { senderId: receiverId, receiverId: { in: page.map((row) => row.senderId) } },
      select: { receiverId: true, status: true },
    });
    const statusByUserId = new Map(requests.map((request) => [request.receiverId.toString(), request.status]));

    const items = page
      .map((row) => {
        const sender = cardByUserId.get(row.senderId.toString());
        if (!sender) return null;
        return {
          heartId: row.id.toString(),
          sender,
          receivedAt: row.updatedAt,
          chatRequestStatus: senderFacingStatus(statusByUserId.get(row.senderId.toString())),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const last = page[page.length - 1];
    return ok(res, { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore });
  } catch (error) { next(error); }
});
