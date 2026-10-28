import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit, refundRateLimits } from "../middleware/rateLimit.js";
import { issueAccessToken } from "../lib/accessToken.js";
import { tokenHash } from "../lib/tokenHash.js";

const registerSchema = z.object({ email: z.email(), password: z.string().min(8), adultVerified: z.literal(true) });
const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
export const authRouter = Router();
// 계정 한도는 한 사람을 집요하게 노리는 공격을 막는다. 그대로 둔다.
// IP 한도는 같은 출구를 쓰는 정상 사용자 여러 명을 함께 막는 쪽 부작용이 크다. 조금 올리되,
// 여러 계정에 비밀번호를 뿌리는 공격을 막는 것은 이 한도뿐이라 크게 열지는 않는다.
authRouter.use("/login", rateLimit("login-ip", 20, 600), rateLimit("login-account", 10, 900, true));
authRouter.use("/register", rateLimit("register-ip", 10, 900));

authRouter.post("/register", async (req, res, next) => {
  try {
    if (config.production) return fail(res, 403, "ADULT_VERIFICATION_REQUIRED", "성인 인증 연동 준비 중입니다.");
    const input = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: input.email } });
    if (exists) return fail(res, 409, "EMAIL_ALREADY_EXISTS", "이미 가입된 이메일입니다.");
    const user = await prisma.user.create({ data: { email: input.email, passwordHash: await bcrypt.hash(input.password, 12), adultVerifiedAt: new Date() } });
    return ok(res, { token: issueAccessToken(user), user: { id: user.id, email: user.email, role: user.role } }, 201);
  } catch (error) { next(error); }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return fail(res, 401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.");
    if (user.status === "SUSPENDED") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    if (user.status === "WITHDRAWN") return fail(res, 403, "FORBIDDEN", "이용할 수 없는 계정입니다.");
    if (!user.adultVerifiedAt) return fail(res, 403, "ADULT_VERIFICATION_REQUIRED", "성인 인증이 필요합니다.");
    await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    // 맞게 들어온 로그인은 한도에서 뺀다. 틀린 시도만 쌓여야 한다.
    await refundRateLimits(req);
    return ok(res, { token: issueAccessToken(user), user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) { next(error); }
});

authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")![1];
    const payload = jwt.decode(token) as jwt.JwtPayload;
    await prisma.revokedAccessToken.upsert({
      where: { tokenHash: tokenHash(token) }, update: {},
      create: { tokenHash: tokenHash(token), userId: req.auth!.userId, expiresAt: new Date(payload.exp! * 1000) },
    });
    return ok(res, { message: "로그아웃되었습니다. 클라이언트 토큰을 삭제해 주세요." });
  } catch (error) { next(error); }
});
