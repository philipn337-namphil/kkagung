import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

const registerSchema = z.object({ email: z.email(), password: z.string().min(8), adultVerified: z.literal(true) });
const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });
const issueToken = (user: { id: bigint; role: "USER" | "ADMIN" }) => jwt.sign({ sub: user.id.toString(), role: user.role }, config.jwtSecret, { expiresIn: "12h" });
export const authRouter = Router();

authRouter.post("/register", async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: input.email } });
    if (exists) return fail(res, 409, "EMAIL_ALREADY_EXISTS", "이미 가입된 이메일입니다.");
    const user = await prisma.user.create({ data: { email: input.email, passwordHash: await bcrypt.hash(input.password, 12), adultVerifiedAt: new Date() } });
    return ok(res, { token: issueToken(user), user: { id: user.id, email: user.email, role: user.role } }, 201);
  } catch (error) { next(error); }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return fail(res, 401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호가 올바르지 않습니다.");
    if (user.status === "SUSPENDED") return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");
    await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    return ok(res, { token: issueToken(user), user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) { next(error); }
});

authRouter.post("/logout", (_req, res) => ok(res, { message: "클라이언트 토큰을 삭제해 로그아웃합니다." }));
