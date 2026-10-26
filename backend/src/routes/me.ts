import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { ok } from "../lib/response.js";
import { tokenHash } from "../lib/tokenHash.js";
import { prisma } from "../prisma.js";

const profileSchema = z.object({ displayName: z.string().min(1).max(30), birthDate: z.coerce.date(), gender: z.enum(["MALE", "FEMALE", "OTHER"]), regionCode: z.string().min(1).max(50), heightCm: z.number().int().min(100).max(250), jobCategory: z.enum(["STUDENT","OFFICE_WORKER","FREELANCER","SELF_EMPLOYED","OTHER"]), mbti: z.string().regex(/^[EI][NS][FT][JP]$/), energyType: z.enum(["EGEN","TETO"]).nullable().optional(), animalFace: z.string().max(30).nullable().optional(), celebrityLookalike: z.string().max(50).nullable().optional(), smokingStatus: z.enum(["SMOKER","NON_SMOKER"]).nullable().optional(), tattooStatus: z.enum(["YES","NO"]).nullable().optional(), militaryService: z.enum(["COMPLETED","NOT_COMPLETED","NOT_APPLICABLE"]).nullable().optional(), intro: z.string().max(200).nullable().optional() });
const preferenceSchema = z.object({ preferredGender: z.enum(["MALE","FEMALE","OTHER"]), minAge: z.number().int().min(19).max(99), maxAge: z.number().int().min(19).max(99), regionScope: z.array(z.string().max(50)).min(1), energyType: z.enum(["EGEN","TETO","ANY"]).default("ANY"), animalFace: z.string().max(30).nullable().optional(), minHeightCm: z.number().int().min(100).max(250).nullable().optional(), smokingStatus: z.enum(["SMOKER","NON_SMOKER","ANY"]).default("ANY"), tattooStatus: z.enum(["YES","NO","ANY"]).default("ANY"), militaryService: z.enum(["COMPLETED","NOT_COMPLETED","NOT_APPLICABLE","ANY"]).default("ANY") }).refine((v) => v.minAge <= v.maxAge, { message: "최소 나이는 최대 나이보다 클 수 없습니다." });
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/", async (req, res, next) => { try { const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, email: true, role: true, status: true, adultVerifiedAt: true, profile: true, preference: true } }); return ok(res, user); } catch (e) { next(e); } });
meRouter.put("/profile", async (req, res, next) => { try { const data = profileSchema.parse(req.body); const profile = await prisma.userProfile.upsert({ where: { userId: req.auth!.userId }, create: { ...data, userId: req.auth!.userId, profileCompletedAt: new Date() }, update: { ...data, profileCompletedAt: new Date() } }); return ok(res, profile); } catch (e) { next(e); } });
meRouter.put("/preferences", async (req, res, next) => { try { const data = preferenceSchema.parse(req.body); const preference = await prisma.userPreference.upsert({ where: { userId: req.auth!.userId }, create: { ...data, userId: req.auth!.userId }, update: data }); return ok(res, preference); } catch (e) { next(e); } });
// 사진 관련 경로는 routes/images.ts 가 "/api/v1/me/images" 에 먼저 붙는다.

/**
 * 탈퇴. 계정 행은 지우지 않고 status 를 WITHDRAWN 으로 바꾼다.
 * WITHDRAWN 은 추천·카드·하트·채팅 조회에서 이미 제외되므로 즉시 모든 목록에서 빠지고,
 * requireAuth 가 막아 원본 사진의 새 서명 URL 도 더 발급되지 않는다.
 *
 * 개인정보 완전 삭제 기준과 보관 기간은 보안·운영과 확정해야 한다(명세서 3절).
 */
meRouter.delete("/", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: "WITHDRAWN", withdrawnAt: now } });
      // 탈퇴 직후에도 기존 토큰이 살아 있으면 안 된다. 로그아웃과 같은 방식으로 폐기한다.
      const token = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")![1];
      const payload = jwt.decode(token) as jwt.JwtPayload;
      await tx.revokedAccessToken.upsert({
        where: { tokenHash: tokenHash(token) }, update: {},
        create: { tokenHash: tokenHash(token), userId, expiresAt: new Date(payload.exp! * 1000) },
      });
    });
    return ok(res, { status: "WITHDRAWN", withdrawnAt: now });
  } catch (error) { next(error); }
});
