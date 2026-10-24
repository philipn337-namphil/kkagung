import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { fortuneDateOf, previewRefreshTargets, readDailyCards, saveRefreshCards, serviceDateOf } from "../lib/recommendation.js";
import { consumeRefreshTicket, readRefreshTicket } from "../lib/refreshTicket.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

const ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  REFRESH_TOKEN_NOT_FOUND: { status: 404, message: "오늘 받은 새로고침권이 없습니다." },
  REFRESH_TOKEN_EXPIRED: { status: 409, message: "새로고침권 사용 시간이 지났습니다." },
  REFRESH_TOKEN_ALREADY_USED: { status: 409, message: "이미 사용한 새로고침권입니다." },
};

const failTicket = (res: Parameters<typeof fail>[0], code: keyof typeof ERROR_MESSAGES) =>
  fail(res, ERROR_MESSAGES[code].status, code, ERROR_MESSAGES[code].message);

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

recommendationsRouter.post("/refresh", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, profile: { select: { userId: true } }, preference: { select: { userId: true } } },
    });
    if (!account) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (account.status === "SUSPENDED" || account.status === "WITHDRAWN") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (!account.profile || !account.preference) return fail(res, 409, "PROFILE_INCOMPLETE", "프로필과 선호 조건을 먼저 등록해 주세요.");

    const now = new Date();
    const serviceDate = serviceDateOf(now);
    const fortune = await prisma.dailyFortune.findUnique({ where: { userId_fortuneDate: { userId, fortuneDate: fortuneDateOf(serviceDate) } } });
    if (fortune === null) return fail(res, 404, "RESOURCE_NOT_FOUND", "오늘 운세가 아직 없습니다.");

    const ticket = await readRefreshTicket(userId, serviceDate);
    if (!ticket) return failTicket(res, "REFRESH_TOKEN_NOT_FOUND");
    if (ticket.status === "USED") return failTicket(res, "REFRESH_TOKEN_ALREADY_USED");
    if (ticket.status === "EXPIRED" || ticket.expiresAt.getTime() <= now.getTime()) return failTicket(res, "REFRESH_TOKEN_EXPIRED");

    // 보여줄 새 후보를 먼저 센다. 한 명도 없으면 권을 쓰지 않고 빈 묶음만 돌려준다.
    const picked = await previewRefreshTargets(userId, serviceDate, fortune.cardCount);
    if (picked.length === 0) {
      return ok(res, { serviceDate, sourceType: "REFRESH", cards: [], refreshTicket: { status: ticket.status, usedAt: ticket.usedAt } });
    }

    const consumed = await consumeRefreshTicket(userId, serviceDate, now);
    if ("errorCode" in consumed) return failTicket(res, consumed.errorCode);

    const { sourceType, cards } = await saveRefreshCards(userId, serviceDate, picked);
    return ok(res, { serviceDate, sourceType, cards, refreshTicket: { status: consumed.token.status, usedAt: consumed.token.usedAt } });
  } catch (error) { next(error); }
});
