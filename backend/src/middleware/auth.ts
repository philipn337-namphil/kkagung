import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { fail } from "../lib/response.js";

type Payload = { sub: string; role: "USER" | "ADMIN" };
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
  try {
    const payload = jwt.verify(token, config.jwtSecret) as Payload;
    req.auth = { userId: BigInt(payload.sub), role: payload.role };
    next();
  } catch { return fail(res, 401, "UNAUTHORIZED", "유효하지 않은 토큰입니다."); }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.auth?.role !== "ADMIN") return fail(res, 403, "FORBIDDEN", "관리자 권한이 필요합니다.");
  next();
};
