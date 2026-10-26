import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { buildPublicCards, fortuneDateOf, serviceDateOf } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { senderFacingStatus } from "./hearts.js";

const UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN"] as const;
const TARGET_UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN", "RECOMMENDATION_BLOCKED"] as const;

export const cardsRouter = Router();

cardsRouter.get("/:targetUserId", requireAuth, async (req, res, next) => {
  try {
    const viewerId = req.auth!.userId;
    const raw = String(req.params.targetUserId);
    // 임의의 사용자 ID 로 프로필을 수집하지 못하게, 자격이 없으면 존재 여부를 알리지 않는다.
    if (!/^\d+$/.test(raw)) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");
    const targetUserId = BigInt(raw);
    if (targetUserId === viewerId) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");

    const me = await prisma.user.findUnique({ where: { id: viewerId }, select: { status: true } });
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    // 오늘 나에게 노출된 카드이거나, 나에게 하트를 보낸 사람만 볼 수 있다.
    const serviceDate = serviceDateOf(new Date());
    const shown = await prisma.recommendationItem.count({
      where: { viewerId, targetUserId, recommendationDate: fortuneDateOf(serviceDate) },
    });
    const heartedMe = shown > 0 ? 0 : await prisma.heart.count({ where: { senderId: targetUserId, receiverId: viewerId, canceledAt: null } });
    if (shown === 0 && heartedMe === 0) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");

    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: viewerId, targetUserId }, { blockerId: targetUserId, targetUserId: viewerId }] },
      select: { blockerId: true },
    });
    if (blocks.some((block) => block.blockerId === viewerId)) return fail(res, 403, "TARGET_BLOCKED", "차단한 상대입니다.");
    if (blocks.length > 0) return fail(res, 403, "BLOCKED_BY_TARGET", "상대가 차단했습니다.");

    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { status: true } });
    if (!target) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");
    if ((TARGET_UNAVAILABLE_STATUS as readonly string[]).includes(target.status)) return fail(res, 403, "TARGET_UNAVAILABLE", "지금은 볼 수 없는 카드입니다.");

    const reasonCode = shown > 0 ? "PREFERENCE_MATCH" : "RECEIVED_HEART";
    const [card] = await buildPublicCards(viewerId, serviceDate, [{ targetUserId, reasonCode }]);
    // 공개할 이미지가 준비되지 않은 상대는 카드로 만들지 않는다.
    if (!card) return fail(res, 404, "RECOMMENDATION_NOT_FOUND", "오늘 노출된 카드가 아닙니다.");

    const [heart, request] = await Promise.all([
      prisma.heart.count({ where: { senderId: viewerId, receiverId: targetUserId, canceledAt: null } }),
      prisma.chatRequest.findFirst({ where: { senderId: viewerId, receiverId: targetUserId }, orderBy: { id: "desc" }, select: { status: true } }),
    ]);

    return ok(res, { card, hearted: heart > 0, chatRequestStatus: senderFacingStatus(request?.status) });
  } catch (error) { next(error); }
});
