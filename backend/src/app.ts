import cors from "cors";
import { randomUUID } from "node:crypto";
import express from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { fail, ok } from "./lib/response.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { prisma } from "./prisma.js";
import { rateLimit } from "./middleware/rateLimit.js";

export const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", rateLimit("api-ip", 90, 60));
app.get("/health", async (_req, res, next) => { try { await prisma.$queryRaw`SELECT 1`; return ok(res, { status: "ok", database: "connected" }); } catch (e) { next(e); } });
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/me", meRouter);
app.use((_req, res) => fail(res, 404, "RESOURCE_NOT_FOUND", "요청한 경로가 없습니다."));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) return fail(res, 400, "VALIDATION_ERROR", "입력 값을 확인해 주세요.");
  // Log only server-generated fields: errors may contain credentials or private content.
  const incidentId = randomUUID();
  console.error({ event: "request_failed", incidentId });
  res.setHeader("X-Incident-Id", incidentId);
  return fail(res, 500, "INTERNAL_SERVER_ERROR", "서버 오류가 발생했습니다.");
});
