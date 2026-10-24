import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { fail } from "../lib/response.js";
import { prisma } from "../prisma.js";

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")?.[1];
  if (!token) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
  let userId: bigint;
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: [config.jwtAlgorithm], issuer: config.jwtIssuer, audience: config.jwtAudience,
    });
    if (typeof payload === "string" || typeof payload.sub !== "string" || !/^[1-9]\d{0,18}$/.test(payload.sub)
      || typeof payload.jti !== "string" || !payload.jti.trim() || payload.jti.length > 128
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.exp! <= payload.iat! || payload.iat! > Math.floor(Date.now() / 1000) + 30) {
      return fail(res, 401, "UNAUTHORIZED", "유효하지 않은 토큰입니다.");
    }
    userId = BigInt(payload.sub);
    if (userId > 9223372036854775807n) return fail(res, 401, "UNAUTHORIZED", "유효하지 않은 토큰입니다.");
  } catch { return fail(res, 401, "UNAUTHORIZED", "유효하지 않은 토큰입니다."); }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }, select: { id: true, role: true, status: true, adultVerifiedAt: true },
    });
    if (!user) return fail(res, 401, "UNAUTHORIZED", "유효하지 않은 계정입니다.");
    if (user.status === "SUSPENDED" || user.status === "WITHDRAWN" || (user.role === "ADMIN" && user.status !== "ACTIVE")) {
      return fail(res, 403, "FORBIDDEN", "이용할 수 없는 계정입니다.");
    }
    if (!user.adultVerifiedAt) return fail(res, 403, "ADULT_VERIFICATION_REQUIRED", "성인 인증이 필요합니다.");
    req.auth = { userId: user.id, role: user.role };
    return next();
  } catch (error) { return next(error); }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.auth?.role !== "ADMIN") return fail(res, 403, "FORBIDDEN", "관리자 권한이 필요합니다.");
  next();
};
