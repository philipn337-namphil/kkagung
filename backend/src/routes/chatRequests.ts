import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { buildPublicCards, fortuneDateOf, serviceDateOf } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { blockedIdsFor, decodeCursor, encodeCursor, parseLimit, senderFacingStatus } from "./hearts.js";

const UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN"] as const;
const TARGET_UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN", "RECOMMENDATION_BLOCKED", "CHAT_RESTRICTED"] as const;

const createSchema = z.object({ targetUserId: z.string().regex(/^\d+$/), message: z.string().min(1).max(200) });
const statusQuerySchema = z.enum(["PENDING", "ACCEPTED", "REJECTED", "IGNORED"]).optional();

const loadMe = (userId: bigint) => prisma.user.findUnique({ where: { id: userId }, select: { status: true } });

export const chatRequestsRouter = Router();

chatRequestsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const senderId = req.auth!.userId;
    const input = createSchema.parse(req.body);
    const receiverId = BigInt(input.targetUserId);
    if (receiverId === senderId) return fail(res, 400, "SELF_ACTION_NOT_ALLOWED", "자신에게는 보낼 수 없습니다.");

    const me = await loadMe(senderId);
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (me.status === "CHAT_RESTRICTED") return fail(res, 403, "CHAT_RESTRICTED", "채팅이 제한된 계정입니다.");

    const target = await prisma.user.findUnique({ where: { id: receiverId }, select: { status: true } });
    if (!target) return fail(res, 403, "CHAT_REQUEST_NOT_ALLOWED", "지금은 요청할 수 없는 상대입니다.");

    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: senderId, targetUserId: receiverId }, { blockerId: receiverId, targetUserId: senderId }] },
      select: { blockerId: true },
    });
    if (blocks.some((block) => block.blockerId === senderId)) return fail(res, 403, "TARGET_BLOCKED", "차단한 상대입니다.");
    if (blocks.length > 0) return fail(res, 403, "BLOCKED_BY_TARGET", "상대가 차단했습니다.");
    if ((TARGET_UNAVAILABLE_STATUS as readonly string[]).includes(target.status)) return fail(res, 403, "TARGET_UNAVAILABLE", "지금은 요청할 수 없는 상대입니다.");

    // 오늘 노출된 카드의 상대이거나, 나에게 하트를 보낸 사람이어야 한다.
    const serviceDate = serviceDateOf(new Date());
    const serviceDateValue = fortuneDateOf(serviceDate);
    const shown = await prisma.recommendationItem.count({ where: { viewerId: senderId, targetUserId: receiverId, recommendationDate: serviceDateValue } });
    const heartedMe = shown > 0 ? 0 : await prisma.heart.count({ where: { senderId: receiverId, receiverId: senderId, canceledAt: null } });
    if (shown === 0 && heartedMe === 0) return fail(res, 403, "CHAT_REQUEST_NOT_ALLOWED", "오늘 노출된 상대가 아닙니다.");

    // 부분 유일 인덱스를 쓸 수 없어, 발신자 행을 잠가 같은 쌍의 PENDING 이 둘 생기지 않게 한다.
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${senderId} FOR UPDATE`;
      const pending = await tx.chatRequest.findFirst({ where: { senderId, receiverId, status: "PENDING" }, select: { id: true } });
      if (pending) return { conflict: "CHAT_REQUEST_ALREADY_PENDING" as const };
      const sameDay = await tx.chatRequest.findFirst({ where: { senderId, receiverId, serviceDate: serviceDateValue }, select: { id: true } });
      if (sameDay) return { conflict: "CHAT_REQUEST_NOT_ALLOWED" as const };
      const row = await tx.chatRequest.create({
        data: {
          senderId,
          receiverId,
          message: input.message,
          sourceType: shown > 0 ? "RECOMMENDATION" : "RECEIVED_HEART",
          serviceDate: serviceDateValue,
        },
        select: { id: true, status: true, createdAt: true },
      });
      return { row };
    });

    if ("conflict" in created) {
      if (created.conflict === "CHAT_REQUEST_ALREADY_PENDING") return fail(res, 409, "CHAT_REQUEST_ALREADY_PENDING", "이미 보낸 요청이 대기 중입니다.");
      return fail(res, 403, "CHAT_REQUEST_NOT_ALLOWED", "오늘은 같은 상대에게 다시 요청할 수 없습니다.");
    }

    return ok(res, { requestId: created.row.id.toString(), targetUserId: receiverId.toString(), status: created.row.status, createdAt: created.row.createdAt }, 201);
  } catch (error) { next(error); }
});

const listRequests = async (res: Response, viewerId: bigint, direction: "received" | "sent", query: Record<string, unknown>) => {
  const status = statusQuerySchema.parse(query.status === undefined ? undefined : String(query.status));
  const limit = parseLimit(query.limit);
  const cursorRaw = typeof query.cursor === "string" ? query.cursor : undefined;
  const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

  const excluded = await blockedIdsFor(viewerId);
  const partnerKey = direction === "received" ? "senderId" : "receiverId";
  const rows = await prisma.chatRequest.findMany({
    where: {
      ...(direction === "received" ? { receiverId: viewerId } : { senderId: viewerId }),
      ...(status === undefined
        // 무시한 요청은 수신자 목록에서 숨긴다. 상태를 직접 지정하면 보여준다.
        ? direction === "received" ? { status: { not: "IGNORED" } } : {}
        : { status }),
      ...(cursorId === null ? {} : { id: { lt: cursorId } }),
      ...(direction === "received"
        ? { sender: { status: { notIn: [...UNAVAILABLE_STATUS] } } }
        : { receiver: { status: { notIn: [...UNAVAILABLE_STATUS] } } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
    select: { id: true, senderId: true, receiverId: true, message: true, status: true, createdAt: true, respondedAt: true },
  });

  const visible = rows.filter((row) => !excluded.has(row[partnerKey].toString()));
  const page = visible.slice(0, limit);
  const hasMore = visible.length > limit;

  const serviceDate = serviceDateOf(new Date());
  const reasonCode = direction === "received" ? "CHAT_REQUEST_RECEIVED" : "CHAT_REQUEST_SENT";
  const cards = await buildPublicCards(viewerId, serviceDate, page.map((row) => ({ targetUserId: row[partnerKey], reasonCode })));
  const cardByUserId = new Map(cards.map((card) => [card.userId, card]));

  const items = page
    .map((row) => {
      const partner = cardByUserId.get(row[partnerKey].toString());
      if (!partner) return null;
      const base = {
        requestId: row.id.toString(),
        message: row.message,
        // 무시한 사실은 발신자에게 알리지 않는다.
        status: direction === "sent" ? senderFacingStatus(row.status) : row.status,
        createdAt: row.createdAt,
        respondedAt: row.respondedAt,
      };
      return direction === "received" ? { ...base, sender: partner } : { ...base, target: partner };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const last = page[page.length - 1];
  return ok(res, { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore });
};

chatRequestsRouter.get("/received", requireAuth, async (req, res, next) => {
  try {
    return await listRequests(res, req.auth!.userId, "received", req.query as Record<string, unknown>);
  } catch (error) { next(error); }
});

chatRequestsRouter.get("/sent", requireAuth, async (req, res, next) => {
  try {
    return await listRequests(res, req.auth!.userId, "sent", req.query as Record<string, unknown>);
  } catch (error) { next(error); }
});

type FailureCode = "CHAT_REQUEST_NOT_FOUND" | "FORBIDDEN" | "CHAT_REQUEST_ALREADY_RESOLVED";
type Found = { ok: true; row: { id: bigint; senderId: bigint; receiverId: bigint; status: string } } | { ok: false; code: FailureCode };

const loadForResponse = async (requestId: string, receiverId: bigint): Promise<Found> => {
  if (!/^\d+$/.test(requestId)) return { ok: false, code: "CHAT_REQUEST_NOT_FOUND" };
  const row = await prisma.chatRequest.findUnique({
    where: { id: BigInt(requestId) },
    select: { id: true, senderId: true, receiverId: true, status: true },
  });
  if (!row) return { ok: false, code: "CHAT_REQUEST_NOT_FOUND" };
  if (row.receiverId !== receiverId) return { ok: false, code: "FORBIDDEN" };
  if (row.status !== "PENDING") return { ok: false, code: "CHAT_REQUEST_ALREADY_RESOLVED" };
  return { ok: true, row };
};

const responseFailure = (res: Response, code: FailureCode) => {
  if (code === "CHAT_REQUEST_NOT_FOUND") return fail(res, 404, code, "요청을 찾을 수 없습니다.");
  if (code === "FORBIDDEN") return fail(res, 403, code, "이 요청을 처리할 권한이 없습니다.");
  return fail(res, 409, code, "이미 처리된 요청입니다.");
};

chatRequestsRouter.post("/:requestId/accept", requireAuth, async (req, res, next) => {
  try {
    const receiverId = req.auth!.userId;
    const me = await loadMe(receiverId);
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (me.status === "CHAT_RESTRICTED") return fail(res, 403, "CHAT_RESTRICTED", "채팅이 제한된 계정입니다.");

    const found = await loadForResponse(String(req.params.requestId), receiverId);
    if (!found.ok) return responseFailure(res, found.code);
    const senderId = found.row.senderId;

    const sender = await prisma.user.findUnique({ where: { id: senderId }, select: { status: true } });
    if (!sender || (TARGET_UNAVAILABLE_STATUS as readonly string[]).includes(sender.status)) return fail(res, 403, "TARGET_UNAVAILABLE", "상대와 채팅을 시작할 수 없습니다.");
    const blockedByTarget = await prisma.block.count({ where: { blockerId: senderId, targetUserId: receiverId } });
    if (blockedByTarget > 0) return fail(res, 403, "BLOCKED_BY_TARGET", "상대가 차단했습니다.");

    const now = new Date();
    // 상태 전이와 방·참여자 생성을 한 트랜잭션으로 묶는다. 동시에 눌러도 한 번만 성공한다.
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.chatRequest.updateMany({ where: { id: found.row.id, status: "PENDING" }, data: { status: "ACCEPTED", respondedAt: now } });
      if (changed.count !== 1) return { conflict: true as const };
      const room = await tx.chatRoom.create({ data: { chatRequestId: found.row.id }, select: { id: true } });
      await tx.chatRoomMember.createMany({ data: [{ roomId: room.id, userId: senderId }, { roomId: room.id, userId: receiverId }] });
      return { roomId: room.id };
    });

    if ("conflict" in result) return responseFailure(res, "CHAT_REQUEST_ALREADY_RESOLVED");
    return ok(res, { requestId: found.row.id.toString(), status: "ACCEPTED", roomId: result.roomId.toString(), respondedAt: now }, 201);
  } catch (error) { next(error); }
});

const resolveWithout = (status: "REJECTED" | "IGNORED") => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const receiverId = req.auth!.userId;
    const me = await loadMe(receiverId);
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    const found = await loadForResponse(String(req.params.requestId), receiverId);
    if (!found.ok) return responseFailure(res, found.code);

    const now = new Date();
    const changed = await prisma.chatRequest.updateMany({ where: { id: found.row.id, status: "PENDING" }, data: { status, respondedAt: now } });
    if (changed.count !== 1) return responseFailure(res, "CHAT_REQUEST_ALREADY_RESOLVED");
    return ok(res, { requestId: found.row.id.toString(), status, respondedAt: now });
  } catch (error) { next(error); }
};

chatRequestsRouter.post("/:requestId/reject", requireAuth, resolveWithout("REJECTED"));
chatRequestsRouter.post("/:requestId/ignore", requireAuth, resolveWithout("IGNORED"));
