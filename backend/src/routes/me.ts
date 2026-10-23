import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

const profileSchema = z.object({ displayName: z.string().min(1).max(30), birthDate: z.coerce.date(), gender: z.enum(["MALE", "FEMALE", "OTHER"]), regionCode: z.string().min(1).max(50), heightCm: z.number().int().min(100).max(250), jobCategory: z.enum(["STUDENT","OFFICE_WORKER","FREELANCER","SELF_EMPLOYED","OTHER"]), mbti: z.string().regex(/^[EI][NS][FT][JP]$/), energyType: z.enum(["EGEN","TETO"]).nullable().optional(), animalFace: z.string().max(30).nullable().optional(), celebrityLookalike: z.string().max(50).nullable().optional(), smokingStatus: z.enum(["SMOKER","NON_SMOKER"]).nullable().optional(), tattooStatus: z.enum(["YES","NO"]).nullable().optional(), militaryService: z.enum(["COMPLETED","NOT_COMPLETED","NOT_APPLICABLE"]).nullable().optional(), intro: z.string().max(200).nullable().optional() });
const preferenceSchema = z.object({ preferredGender: z.enum(["MALE","FEMALE","OTHER"]), minAge: z.number().int().min(19).max(99), maxAge: z.number().int().min(19).max(99), regionScope: z.array(z.string().max(50)).min(1), energyType: z.enum(["EGEN","TETO","ANY"]).default("ANY"), animalFace: z.string().max(30).nullable().optional(), minHeightCm: z.number().int().min(100).max(250).nullable().optional(), smokingStatus: z.enum(["SMOKER","NON_SMOKER","ANY"]).default("ANY"), tattooStatus: z.enum(["YES","NO","ANY"]).default("ANY"), militaryService: z.enum(["COMPLETED","NOT_COMPLETED","NOT_APPLICABLE","ANY"]).default("ANY") }).refine((v) => v.minAge <= v.maxAge, { message: "최소 나이는 최대 나이보다 클 수 없습니다." });
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/", async (req, res, next) => { try { const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, email: true, role: true, status: true, adultVerifiedAt: true, profile: true, preference: true } }); return ok(res, user); } catch (e) { next(e); } });
meRouter.put("/profile", async (req, res, next) => { try { const data = profileSchema.parse(req.body); const profile = await prisma.userProfile.upsert({ where: { userId: req.auth!.userId }, create: { ...data, userId: req.auth!.userId, profileCompletedAt: new Date() }, update: { ...data, profileCompletedAt: new Date() } }); return ok(res, profile); } catch (e) { next(e); } });
meRouter.put("/preferences", async (req, res, next) => { try { const data = preferenceSchema.parse(req.body); const preference = await prisma.userPreference.upsert({ where: { userId: req.auth!.userId }, create: { ...data, userId: req.auth!.userId }, update: data }); return ok(res, preference); } catch (e) { next(e); } });
meRouter.get("/images/status", (_req, res) => fail(res, 501, "NOT_IMPLEMENTED", "이미지 업로드는 Phase 2에서 구현합니다."));
