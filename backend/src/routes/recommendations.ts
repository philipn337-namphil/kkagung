import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { fortuneDateOf, readDailyCards, serviceDateOf } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

export const recommendationsRouter = Router();
recommendationsRouter.use(requireAuth);

recommendationsRouter.get("/today", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, profile: { select: { userId: true } }, preference: { select: { userId: true } } },
    });
    if (!account) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (account.status === "SUSPENDED" || account.status === "WITHDRAWN") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (!account.profile || !account.preference) return fail(res, 409, "PROFILE_INCOMPLETE", "프로필과 선호 조건을 먼저 등록해 주세요.");

    const serviceDate = serviceDateOf(new Date());
    const fortune = await prisma.dailyFortune.findUnique({ where: { userId_fortuneDate: { userId, fortuneDate: fortuneDateOf(serviceDate) } } });
    if (fortune === null) return fail(res, 404, "RESOURCE_NOT_FOUND", "오늘 운세가 아직 없습니다.");

    const { sourceType, cards } = await readDailyCards(userId, serviceDate);
    // 하트·채팅 요청 테이블이 아직 없어 두 목록은 빈 배열이다.
    return ok(res, { serviceDate, sourceType, cards, heartedUserIds: [], requestedUserIds: [] });
  } catch (error) { next(error); }
});
