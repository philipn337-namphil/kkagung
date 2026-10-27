import { Router } from "express";
import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { buildPublicCards, serviceDateOf } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { blockedIdsFor, decodeCursor, encodeCursor, parseLimit } from "./hearts.js";
import { privateObjectUrl, storageReady } from "../lib/objectStorage.js";

const UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN"] as const;
const PREVIEW_LENGTH = 60;

const messageSchema = z.object({ body: z.string().min(1).max(1000), clientMessageId: z.string().min(1).max(64).optional() });

type Membership =
  | { ok: true; roomId: bigint; createdAt: Date; partnerId: bigint; lastReadMessageId: bigint | null; requestAccepted: boolean }
  | { ok: false; code: "CHAT_ROOM_NOT_FOUND" | "NOT_ROOM_MEMBER" };

const loadMembership = async (roomIdRaw: string, userId: bigint): Promise<Membership> => {
  if (!/^\d+$/.test(roomIdRaw)) return { ok: false, code: "CHAT_ROOM_NOT_FOUND" };
  const room = await prisma.chatRoom.findUnique({
    where: { id: BigInt(roomIdRaw) },
    select: { id: true, createdAt: true, chatRequest: { select: { status: true } }, members: { select: { userId: true, lastReadMessageId: true } } },
  });
  if (!room) return { ok: false, code: "CHAT_ROOM_NOT_FOUND" };
  const mine = room.members.find((member) => member.userId === userId);
  if (!mine) return { ok: false, code: "NOT_ROOM_MEMBER" };
  const partner = room.members.find((member) => member.userId !== userId);
  if (!partner) return { ok: false, code: "CHAT_ROOM_NOT_FOUND" };
  return { ok: true, roomId: room.id, createdAt: room.createdAt, partnerId: partner.userId, lastReadMessageId: mine.lastReadMessageId,
    requestAccepted: room.chatRequest.status === "ACCEPTED" };
};

const membershipFailure = (res: Response, code: "CHAT_ROOM_NOT_FOUND" | "NOT_ROOM_MEMBER") =>
  code === "CHAT_ROOM_NOT_FOUND"
    ? fail(res, 404, code, "채팅방을 찾을 수 없습니다.")
    : fail(res, 403, code, "채팅방 참여자가 아닙니다.");

const ageOf = (birthDate: Date) => {
  const now = new Date();
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthDate.getUTCDate())) age -= 1;
  return age;
};

export const chatRoomsRouter = Router();

chatRoomsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const limit = parseLimit(req.query.limit);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

    const memberships = await prisma.chatRoomMember.findMany({
      where: { userId, ...(cursorId === null ? {} : { roomId: { lt: cursorId } }) },
      orderBy: { roomId: "desc" },
      take: limit + 1,
      select: { roomId: true, lastReadMessageId: true, room: { select: { createdAt: true, members: { select: { userId: true } } } } },
    });

    const excluded = await blockedIdsFor(userId);
    const rows = memberships
      .map((membership) => {
        const partnerId = membership.room.members.find((member) => member.userId !== userId)?.userId;
        return partnerId === undefined ? null : { ...membership, partnerId };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null && !excluded.has(row.partnerId.toString()));

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const serviceDate = serviceDateOf(new Date());
    const cards = await buildPublicCards(userId, serviceDate, page.map((row) => ({ targetUserId: row.partnerId, reasonCode: "CHAT_PARTNER" })));
    const cardByUserId = new Map(cards.map((card) => [card.userId, card]));

    const items = [];
    for (const row of page) {
      // 정지·탈퇴한 상대는 공개 카드가 만들어지지 않으므로 목록에서 빠진다.
      const partner = cardByUserId.get(row.partnerId.toString());
      if (!partner) continue;
      const last = await prisma.chatMessage.findFirst({ where: { roomId: row.roomId }, orderBy: { id: "desc" }, select: { body: true, createdAt: true, senderId: true } });
      const unreadCount = await prisma.chatMessage.count({
        where: { roomId: row.roomId, senderId: { not: userId }, ...(row.lastReadMessageId === null ? {} : { id: { gt: row.lastReadMessageId } }) },
      });
      items.push({
        roomId: row.roomId.toString(),
        partner,
        lastMessage: last === null ? null : { preview: last.body.slice(0, PREVIEW_LENGTH), sentAt: last.createdAt, senderId: last.senderId.toString() },
        unreadCount,
        createdAt: row.room.createdAt,
      });
    }

    const lastRow = page[page.length - 1];
    return ok(res, { items, nextCursor: hasMore && lastRow ? encodeCursor(lastRow.roomId) : null, hasMore });
  } catch (error) { next(error); }
});

chatRoomsRouter.get("/:roomId", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const membership = await loadMembership(String(req.params.roomId), userId);
    if (!membership.ok) return membershipFailure(res, membership.code);
    if (!membership.requestAccepted) return membershipFailure(res, "CHAT_ROOM_NOT_FOUND");

    const [me, partner] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { status: true } }),
      prisma.user.findUnique({
        where: { id: membership.partnerId },
        select: { status: true, profile: true },
      }),
    ]);
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (!partner?.profile) return fail(res, 404, "CHAT_ROOM_NOT_FOUND", "채팅방을 찾을 수 없습니다.");

    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: userId, targetUserId: membership.partnerId }, { blockerId: membership.partnerId, targetUserId: userId }] },
      select: { blockerId: true },
    });
    const blockedByMe = blocks.some((block) => block.blockerId === userId);
    const blockedByPartner = blocks.some((block) => block.blockerId === membership.partnerId);
    const partnerUnavailable = (UNAVAILABLE_STATUS as readonly string[]).includes(partner.status);
    const meRestricted = (UNAVAILABLE_STATUS as readonly string[]).includes(me.status) || me.status === "CHAT_RESTRICTED";
    const canSendMessage = !blockedByMe && !blockedByPartner && !partnerUnavailable && !meRestricted;

    // 수락된 방의 참여자에게만, 현재 차단·계정 상태를 다시 확인한 뒤 발급한다.
    // 메시지 제한(CHAT_RESTRICTED)은 기존 사진 열람 권한과 별개다.
    const canRevealOriginals = !blockedByMe && !blockedByPartner && !partnerUnavailable
      && !(UNAVAILABLE_STATUS as readonly string[]).includes(me.status);
    const originalImages: { imageId: string; url: string; expiresAt: Date }[] = [];
    if (canRevealOriginals && storageReady()) {
      const photos = await prisma.profileImage.findMany({
        where: { userId: membership.partnerId, imageType: "ORIGINAL_PRIVATE", generationStatus: "DONE", objectKey: { not: "" } },
        orderBy: [{ slot: "asc" }, { id: "asc" }], take: 3, select: { id: true, objectKey: true },
      });
      for (const photo of photos) originalImages.push({
        imageId: photo.id.toString(), url: await privateObjectUrl(photo.objectKey, 60), expiresAt: new Date(Date.now() + 60_000),
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return ok(res, {
      roomId: membership.roomId.toString(),
      createdAt: membership.createdAt,
      partner: {
        userId: membership.partnerId.toString(),
        displayName: partner.profile.displayName,
        age: ageOf(partner.profile.birthDate),
        gender: partner.profile.gender,
        regionLabel: partner.profile.regionCode,
        heightCm: partner.profile.heightCm,
        jobCategory: partner.profile.jobCategory,
        mbti: partner.profile.mbti,
        intro: partner.profile.intro,
        hobbies: [],
        smokingStatus: partner.profile.smokingStatus,
        tattooStatus: partner.profile.tattooStatus,
        militaryService: partner.profile.militaryService,
        celebrityLookalike: partner.profile.celebrityLookalike,
        originalImages,
      },
      canSendMessage,
      blockedByMe,
      blockedByPartner,
    });
  } catch (error) { next(error); }
});

chatRoomsRouter.get("/:roomId/messages", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const membership = await loadMembership(String(req.params.roomId), userId);
    if (!membership.ok) return membershipFailure(res, membership.code);

    const limit = parseLimit(req.query.limit);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursorId = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && cursorId === null) return fail(res, 400, "VALIDATION_ERROR", "커서 값이 올바르지 않습니다.");

    const rows = await prisma.chatMessage.findMany({
      where: { roomId: membership.roomId, ...(cursorId === null ? {} : { id: { lt: cursorId } }) },
      orderBy: { id: "desc" },
      take: limit + 1,
      select: { id: true, senderId: true, body: true, createdAt: true },
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    // 조회하면 읽음 위치를 가장 최근 메시지로 올린다.
    const newest = await prisma.chatMessage.findFirst({ where: { roomId: membership.roomId }, orderBy: { id: "desc" }, select: { id: true } });
    if (newest && (membership.lastReadMessageId === null || newest.id > membership.lastReadMessageId)) {
      await prisma.chatRoomMember.updateMany({
        where: { roomId: membership.roomId, userId },
        data: { lastReadMessageId: newest.id, lastReadAt: new Date() },
      });
    }

    const items = page.map((row) => ({ messageId: row.id.toString(), senderId: row.senderId.toString(), body: row.body, sentAt: row.createdAt }));
    const lastRow = page[page.length - 1];
    return ok(res, { items, nextCursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null, hasMore });
  } catch (error) { next(error); }
});

chatRoomsRouter.post("/:roomId/messages", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const input = messageSchema.parse(req.body);
    const membership = await loadMembership(String(req.params.roomId), userId);
    if (!membership.ok) return membershipFailure(res, membership.code);

    const [me, partner] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { status: true } }),
      prisma.user.findUnique({ where: { id: membership.partnerId }, select: { status: true } }),
    ]);
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (me.status === "CHAT_RESTRICTED") return fail(res, 403, "CHAT_RESTRICTED", "채팅이 제한된 계정입니다.");
    if (!partner || (UNAVAILABLE_STATUS as readonly string[]).includes(partner.status)) return fail(res, 403, "TARGET_UNAVAILABLE", "상대와 채팅할 수 없습니다.");

    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: userId, targetUserId: membership.partnerId }, { blockerId: membership.partnerId, targetUserId: userId }] },
      select: { blockerId: true },
    });
    if (blocks.some((block) => block.blockerId === userId)) return fail(res, 403, "TARGET_BLOCKED", "차단한 상대입니다.");
    if (blocks.length > 0) return fail(res, 403, "BLOCKED_BY_TARGET", "상대가 차단했습니다.");

    const sent = (row: { id: bigint; senderId: bigint; body: string; createdAt: Date }) =>
      ok(res, { messageId: row.id.toString(), senderId: row.senderId.toString(), body: row.body, sentAt: row.createdAt }, 201);

    if (input.clientMessageId !== undefined) {
      const existing = await prisma.chatMessage.findUnique({
        where: { roomId_senderId_clientMessageId: { roomId: membership.roomId, senderId: userId, clientMessageId: input.clientMessageId } },
        select: { id: true, senderId: true, body: true, createdAt: true },
      });
      if (existing) return sent(existing);
    }

    try {
      const created = await prisma.chatMessage.create({
        data: { roomId: membership.roomId, senderId: userId, body: input.body, clientMessageId: input.clientMessageId ?? null },
        select: { id: true, senderId: true, body: true, createdAt: true },
      });
      return sent(created);
    } catch (error) {
      // 같은 재시도 키의 요청이 먼저 저장했다면 유니크 충돌이 난다. 그 메시지를 돌려준다.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002" || input.clientMessageId === undefined) throw error;
      const existing = await prisma.chatMessage.findUniqueOrThrow({
        where: { roomId_senderId_clientMessageId: { roomId: membership.roomId, senderId: userId, clientMessageId: input.clientMessageId } },
        select: { id: true, senderId: true, body: true, createdAt: true },
      });
      return sent(existing);
    }
  } catch (error) { next(error); }
});
