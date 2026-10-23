// 아래 라우터 등록 조건이 process.env 를 직접 읽으므로, .env 를 먼저 적재한다.
import "dotenv/config";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { fail, ok } from "./lib/response.js";
import { authRouter } from "./routes/auth.js";
import { devRouter } from "./routes/dev.js";
import { meRouter } from "./routes/me.js";
import { prisma } from "./prisma.js";

export const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "1mb" }));
app.get("/health", async (_req, res, next) => { try { await prisma.$queryRaw`SELECT 1`; return ok(res, { status: "ok", database: "connected" }); } catch (e) { next(e); } });
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/me", meRouter);
// 개발·시연 전용. 꺼져 있거나 운영 환경이면 등록하지 않아 아래 404 처리가 그대로 응답한다.
if (process.env.ENABLE_TEST_ACCOUNTS === "true" && process.env.APP_ENV !== "production" && process.env.NODE_ENV !== "production") app.use("/api/v1/dev", devRouter);
app.use((_req, res) => fail(res, 404, "RESOURCE_NOT_FOUND", "요청한 경로가 없습니다."));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (error instanceof ZodError) return fail(res, 400, "VALIDATION_ERROR", error.issues.map((i) => i.message).join(", ")); console.error(error); return fail(res, 500, "INTERNAL_SERVER_ERROR", "서버 오류가 발생했습니다."); });
