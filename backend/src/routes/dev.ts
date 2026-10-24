import { Router } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

// 시드 전용 계정만 노출한다. 실제 가입자는 목록에도, 선택에도 나오지 않는다.
const SEED_EMAIL_DOMAIN = "@kkagung.local";
const isSeedAccount = (email: string) => email.endsWith(SEED_EMAIL_DOMAIN);

// 만료는 환경변수로 분리한다. 값이 없으면 개발 기본값을 쓴다.
const tokenTtl = () => process.env.JWT_EXPIRES_IN ?? "12h";
const issueToken = (user: { id: bigint; role: "USER" | "ADMIN" }) =>
  jwt.sign({ sub: user.id.toString(), role: user.role }, config.jwtSecret, { expiresIn: tokenTtl() as jwt.SignOptions["expiresIn"] });

// 서비스 날짜는 한국 시간 오전 8시 기준이다. KST = UTC+9 이므로 9시간 더하고 8시간 뺀 날짜를 쓴다.
const serviceDate = (now: Date) => new Date(now.getTime() + (9 - 8) * 60 * 60 * 1000).toISOString().slice(0, 10);

const ageOf = (birthDate: Date) => {
  const now = new Date();
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthDate.getUTCDate())) age -= 1;
  return age;
};

export const devRouter = Router();

devRouter.get("/test-accounts", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { email: { endsWith: SEED_EMAIL_DOMAIN } },
      select: { id: true, email: true, role: true, profile: { select: { displayName: true, gender: true, birthDate: true, profileCompletedAt: true } } },
      orderBy: { id: "asc" },
    });
    const accounts = users.map((user) => ({
      accountId: user.id.toString(),
      email: user.email,
      role: user.role,
      displayName: user.profile?.displayName ?? null,
      gender: user.profile?.gender ?? null,
      age: user.profile ? ageOf(user.profile.birthDate) : null,
      profileCompleted: user.profile?.profileCompletedAt != null,
    }));
    return ok(res, { accounts });
  } catch (error) { next(error); }
});

devRouter.post("/test-accounts/reseed", async (_req, res, next) => {
  try {
    const accountCount = await prisma.user.count({ where: { email: { endsWith: SEED_EMAIL_DOMAIN } } });
    // 지워야 할 상호작용 테이블(하트, 채팅 요청·방·메시지, 신고, 차단, 운세·추천·새로고침권)은
    // 아직 스키마에 없다. 해당 모델이 추가되면 여기서 시드 계정의 행만 삭제한다.
    return ok(res, { reseeded: true, accountCount, serviceDate: serviceDate(new Date()) });
  } catch (error) { next(error); }
});

devRouter.post("/test-accounts/:accountId/token", async (req, res, next) => {
  try {
    const accountId = req.params.accountId;
    if (!/^\d+$/.test(accountId)) return fail(res, 404, "RESOURCE_NOT_FOUND", "요청한 경로가 없습니다.");
    const user = await prisma.user.findUnique({ where: { id: BigInt(accountId) }, select: { id: true, email: true, role: true, status: true } });
    if (!user || !isSeedAccount(user.email)) return fail(res, 404, "RESOURCE_NOT_FOUND", "요청한 경로가 없습니다.");
    if (user.status === "SUSPENDED") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    return ok(res, { token: issueToken(user), user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) { next(error); }
});
