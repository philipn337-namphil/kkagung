import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Request, RequestHandler } from "express";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { fail } from "../lib/response.js";
import { clientIp } from "../lib/clientIp.js";

/**
 * 성공한 요청까지 한도를 깎으면, 한 번도 틀리지 않은 사용자가 몇 번 만에 잠긴다.
 * 한도는 틀린 시도를 막기 위한 것이다. 성공을 확인한 핸들러가 refundRateLimits 로 되돌린다.
 * 미들웨어는 핸들러보다 먼저 돌아 결과를 알 수 없으므로, 일단 세고 나중에 빼는 방식이다.
 */
type Refund = () => Promise<unknown>;
const pendingRefunds = new WeakMap<Request, Refund[]>();

export const refundRateLimits = async (req: Request) => {
  const refunds = pendingRefunds.get(req);
  if (refunds === undefined) return;
  pendingRefunds.delete(req);
  // 되돌리지 못해도 요청 처리를 막지 않는다. 다음 창에서 자연히 풀린다.
  await Promise.allSettled(refunds.map((refund) => refund()));
};

// All instances must share the DB and JWT key. 프록시 헤더는 TRUST_PROXY 로 명시한 구간만 신뢰한다.
export const rateLimit = (scope: string, limit: number, windowSeconds: number, account = false): RequestHandler =>
  async (req, res, next) => {
    try {
      const identity = account
        ? String(typeof req.body?.email === "string" ? req.body.email : "").trim().toLowerCase().slice(0, 255)
        : clientIp(req);
      const keyHash = createHmac("sha256", config.jwtSecret).update(scope + ":" + identity).digest("hex");
      const now = Date.now();
      const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
      const expiresAt = new Date(windowStart.getTime() + windowSeconds * 1000);
      const where = { keyHash_windowStart: { keyHash, windowStart } };
      const counter = await prisma.rateLimitCounter.upsert({
        where,
        create: { keyHash, windowStart, expiresAt, count: 1 },
        update: { count: { increment: 1 } },
        select: { count: true },
      }).catch(error => {
        // Concurrent first requests can race in Prisma's emulated MySQL upsert.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        return prisma.rateLimitCounter.update({ where, data: { count: { increment: 1 } }, select: { count: true } });
      });
      if (counter.count > limit) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000))));
        res.setHeader("Cache-Control", "no-store");
        return fail(res, 429, "TOO_MANY_REQUESTS", "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
      }
      const refunds = pendingRefunds.get(req) ?? [];
      refunds.push(() => prisma.rateLimitCounter.update({ where, data: { count: { decrement: 1 } } }));
      pendingRefunds.set(req, refunds);
      next();
    } catch (error) { next(error); } // Storage failure never silently disables protection.
  };
