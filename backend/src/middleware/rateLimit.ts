import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { fail } from "../lib/response.js";
import { clientIp } from "../lib/clientIp.js";

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
      next();
    } catch (error) { next(error); } // Storage failure never silently disables protection.
  };
