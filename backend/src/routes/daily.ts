import { Router } from "express";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth.js";
import { ensureDailyCards } from "../lib/recommendation.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

// 서비스 하루는 한국 시간 오전 8시부터다. 8시 이전 요청은 전날 서비스 날짜에 속한다.
const KST_OFFSET_HOURS = 9;
const SERVICE_DAY_START_HOUR = 8;
const serviceDateOf = (now: Date) =>
  new Date(now.getTime() + (KST_OFFSET_HOURS - SERVICE_DAY_START_HOUR) * 60 * 60 * 1000).toISOString().slice(0, 10);
const fortuneDateOf = (serviceDate: string) => new Date(`${serviceDate}T00:00:00Z`);

// 등급·점수 산정 규칙은 문서에 없다. 같은 사용자·같은 서비스 날짜면 항상 같은 결과가 나오도록
// 사용자 id 와 서비스 날짜를 해시해 0~100 점수를 만들고, 점수 구간으로 등급과 카드 수를 정한다.
const BANDS = [
  { grade: "GREAT", minScore: 85, cardCount: 7, message: "오늘은 먼저 말을 걸어보기 좋은 날이에요." },
  { grade: "GOOD", minScore: 55, cardCount: 5, message: "가까운 거리에서 좋은 인연이 기다려요." },
  { grade: "NORMAL", minScore: 25, cardCount: 3, message: "평소처럼 편안한 하루예요." },
  { grade: "BAD", minScore: 0, cardCount: 3, message: "오늘은 천천히 쉬어가도 좋아요." },
] as const;

const fortuneOf = (userId: bigint, serviceDate: string) => {
  const score = createHash("sha256").update(`${userId}:${serviceDate}`).digest().readUInt32BE(0) % 101;
  const band = BANDS.find((candidate) => score >= candidate.minScore) ?? BANDS[BANDS.length - 1];
  return { grade: band.grade, score, cardCount: band.cardCount, message: band.message };
};

const fortuneView = (fortune: { grade: string; score: number; cardCount: number; message: string; openedAt: Date | null }) => ({
  grade: fortune.grade,
  score: fortune.score,
  cardCount: fortune.cardCount,
  message: fortune.message,
  openedAt: fortune.openedAt,
});

// 새로고침권 지급(선착순 재고 차감)은 새로고침권 API 가 담당한다. 여기서는 현재 상태만 읽는다.
const ticketView = (token: { status: string; expiresAt: Date } | null, now: Date) => {
  if (token === null) return { status: "NOT_GRANTED", granted: false, expiresAt: null };
  const status = token.status === "AVAILABLE" && token.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : token.status;
  return { status, granted: false, expiresAt: token.expiresAt };
};

const loadAccount = (userId: bigint) =>
  prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, profile: { select: { userId: true } }, preference: { select: { userId: true } } },
  });

export const dailyRouter = Router();
dailyRouter.use(requireAuth);

dailyRouter.post("/open", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const account = await loadAccount(userId);
    if (!account) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (account.status === "SUSPENDED" || account.status === "WITHDRAWN") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (!account.profile || !account.preference) return fail(res, 409, "PROFILE_INCOMPLETE", "프로필과 선호 조건을 먼저 등록해 주세요.");

    const now = new Date();
    const serviceDate = serviceDateOf(now);
    const fortuneDate = fortuneDateOf(serviceDate);
    const where = { userId_fortuneDate: { userId, fortuneDate } };

    let fortune = await prisma.dailyFortune.findUnique({ where });
    let firstOpen = false;

    if (fortune === null) {
      try {
        fortune = await prisma.dailyFortune.create({ data: { userId, fortuneDate, ...fortuneOf(userId, serviceDate), openedAt: now } });
        firstOpen = true;
      } catch (error) {
        // 같은 순간에 들어온 다른 요청이 먼저 만들었다면 유니크 충돌이 난다. 그 행을 다시 읽어 돌려준다.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        fortune = await prisma.dailyFortune.findUniqueOrThrow({ where });
      }
    } else if (fortune.openedAt === null) {
      fortune = await prisma.dailyFortune.update({ where: { id: fortune.id }, data: { openedAt: now } });
      firstOpen = true;
    }

    const token = await prisma.refreshToken.findUnique({ where: { userId_tokenDate: { userId, tokenDate: fortuneDate } } });
    const { cards } = await ensureDailyCards(userId, serviceDate, fortune.cardCount);
    return ok(res, { serviceDate, fortune: fortuneView(fortune), refreshTicket: ticketView(token, now), cards, firstOpen });
  } catch (error) { next(error); }
});

dailyRouter.get("/", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const account = await loadAccount(userId);
    if (!account) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (account.status === "SUSPENDED" || account.status === "WITHDRAWN") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    const now = new Date();
    const serviceDate = serviceDateOf(now);
    const fortuneDate = fortuneDateOf(serviceDate);

    const fortune = await prisma.dailyFortune.findUnique({ where: { userId_fortuneDate: { userId, fortuneDate } } });
    if (fortune === null) return fail(res, 404, "RESOURCE_NOT_FOUND", "오늘 운세가 아직 없습니다.");

    const token = await prisma.refreshToken.findUnique({ where: { userId_tokenDate: { userId, tokenDate: fortuneDate } } });
    return ok(res, { serviceDate, fortune: fortuneView(fortune), refreshTicket: ticketView(token, now) });
  } catch (error) { next(error); }
});
