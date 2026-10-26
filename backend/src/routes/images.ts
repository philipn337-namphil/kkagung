import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  MAX_BYTES, MAX_IMAGES_PER_USER, objectKeyFor, prepareImage,
} from "../lib/imageProcessing.js";
import {
  deleteObject, privateBucket, privateObjectUrl, publicBucket, publicObjectUrl, putObject, storageReady,
} from "../lib/objectStorage.js";

export const imagesRouter = Router();
imagesRouter.use(requireAuth);

// 파일은 메모리에서 검사한 뒤 다시 인코딩해 올린다. 디스크에 원본을 남기지 않기 위해서다.
// multer 의 한도는 1차 방어이고, 실제 형식·해상도 판정은 prepareImage 가 한다.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
const slotSchema = z.coerce.number().int().min(1).max(MAX_IMAGES_PER_USER).optional();

const noStore = (res: Parameters<typeof ok>[0]) => res.setHeader("Cache-Control", "no-store");

/** 한 장(slot)에 원본·블러·AI 행이 함께 달린다. 목록은 slot 단위로 묶어서 보여준다. */
const loadSlots = (userId: bigint) =>
  prisma.profileImage.findMany({ where: { userId }, orderBy: [{ slot: "asc" }, { id: "asc" }] });

imagesRouter.get("/", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const rows = await loadSlots(userId);
    const bySlot = new Map<number, typeof rows>();
    for (const row of rows) bySlot.set(row.slot, [...(bySlot.get(row.slot) ?? []), row]);

    const images = [];
    for (const [slot, group] of [...bySlot.entries()].sort((a, b) => a[0] - b[0])) {
      const original = group.find((row) => row.imageType === "ORIGINAL_PRIVATE");
      const shown = group.find((row) => row.imageType === "AI_PUBLIC" && row.generationStatus === "DONE")
        ?? group.find((row) => row.imageType === "BLURRED_PUBLIC");
      // AI 변환이 아직이면 그 상태를 그대로 알린다(D-02). 블러가 있어도 DONE 으로 꾸미지 않는다.
      const ai = group.find((row) => row.imageType === "AI_PUBLIC");
      images.push({
        imageId: (original ?? group[0]).id.toString(),
        slot,
        generationStatus: ai?.generationStatus ?? "PENDING",
        publicUrl: shown ? publicObjectUrl(shown.objectKey) : null,
        publicType: shown?.imageType ?? null,
        // 본인 요청이므로 원본을 짧은 서명 URL 로 내려준다. object key 자체는 응답에 넣지 않는다.
        originalUrl: original ? await privateObjectUrl(original.objectKey, 60) : null,
        originalUrlExpiresAt: original ? new Date(Date.now() + 60_000) : null,
        uploadedAt: (original ?? group[0]).createdAt,
      });
    }
    noStore(res);
    return ok(res, { images });
  } catch (error) { next(error); }
});

imagesRouter.get("/status", async (req, res, next) => {
  try {
    const rows = await loadSlots(req.auth!.userId);
    const items = rows
      .filter((row) => row.imageType !== "ORIGINAL_PRIVATE")
      .map((row) => ({
        imageId: row.id.toString(), slot: row.slot, type: row.imageType,
        status: row.generationStatus, failedReasonCode: row.failedReasonCode,
        publicUrl: row.generationStatus === "DONE" ? publicObjectUrl(row.objectKey) : null,
      }));
    noStore(res);
    return ok(res, { items });
  } catch (error) { next(error); }
});

imagesRouter.post("/", upload.single("file"), async (req, res, next) => {
  try {
    if (!storageReady()) return fail(res, 503, "SERVICE_UNAVAILABLE", "사진 저장소가 준비되지 않았습니다.");
    const userId = req.auth!.userId;
    if (!req.file) return fail(res, 400, "VALIDATION_ERROR", "사진 파일이 필요합니다.");
    const requestedSlot = slotSchema.parse(req.body?.slot);

    const used = await prisma.profileImage.findMany({
      where: { userId, imageType: "ORIGINAL_PRIVATE" }, select: { slot: true },
    });
    const taken = new Set(used.map((row) => row.slot));
    if (requestedSlot !== undefined && taken.has(requestedSlot)) {
      return fail(res, 409, "IMAGE_LIMIT_EXCEEDED", "이미 사용 중인 자리입니다. 기존 사진을 지우고 올려주세요.");
    }
    const slot = requestedSlot ?? [1, 2, 3].find((candidate) => !taken.has(candidate));
    if (slot === undefined) {
      return fail(res, 409, "IMAGE_LIMIT_EXCEEDED", `사진은 최대 ${MAX_IMAGES_PER_USER}장까지 올릴 수 있습니다.`);
    }

    const prepared = await prepareImage(req.file.buffer);
    if ("code" in prepared) return fail(res, prepared.status, prepared.code, prepared.message);

    const originalKey = objectKeyFor("original", userId, "jpg");
    const blurredKey = objectKeyFor("blurred", userId, "webp");
    await putObject(privateBucket(), originalKey, prepared.original.body, prepared.original.contentType);
    await putObject(publicBucket(), blurredKey, prepared.blurred.body, prepared.blurred.contentType);

    // 세 행을 한 트랜잭션으로 남긴다. AI 는 공급자가 정해지기 전까지 PENDING 으로 둔다(D-02).
    const created = await prisma.$transaction(async (tx) => {
      const original = await tx.profileImage.create({
        data: {
          userId, slot, imageType: "ORIGINAL_PRIVATE", objectKey: originalKey, generationStatus: "DONE",
          byteSize: prepared.original.byteSize, width: prepared.original.width, height: prepared.original.height,
          processedAt: new Date(),
        },
      });
      await tx.profileImage.create({
        data: {
          userId, slot, imageType: "BLURRED_PUBLIC", objectKey: blurredKey, generationStatus: "DONE",
          byteSize: prepared.blurred.byteSize, width: prepared.blurred.width, height: prepared.blurred.height,
          processedAt: new Date(),
        },
      });
      await tx.profileImage.create({
        data: {
          userId, slot, imageType: "AI_PUBLIC", objectKey: "", generationStatus: "PENDING",
          byteSize: 0, width: 0, height: 0,
        },
      });
      return original;
    });

    noStore(res);
    return ok(res, { imageId: created.id.toString(), slot, generationStatus: "PENDING" }, 202);
  } catch (error) { next(error); }
});

imagesRouter.delete("/:imageId", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    if (!/^[1-9]\d{0,18}$/.test(req.params.imageId)) {
      return fail(res, 404, "RESOURCE_NOT_FOUND", "사진을 찾을 수 없습니다.");
    }
    const target = await prisma.profileImage.findUnique({ where: { id: BigInt(req.params.imageId) } });
    // 남의 사진인지 여부를 구분해 알려주지 않는다. 없는 것과 같은 404 로 답한다.
    if (target === null || target.userId !== userId) {
      return fail(res, 404, "RESOURCE_NOT_FOUND", "사진을 찾을 수 없습니다.");
    }

    // 같은 자리의 원본·블러·AI 를 함께 지운다. 한 버전만 남으면 카드에 유령 이미지가 남는다.
    const group = await prisma.profileImage.findMany({ where: { userId, slot: target.slot } });
    for (const row of group) {
      if (row.objectKey === "") continue;
      const bucket = row.imageType === "ORIGINAL_PRIVATE" ? privateBucket() : publicBucket();
      // 저장소에서 지우지 못해도 행은 지운다. 남은 객체는 수명 주기 정책으로 정리한다.
      try { await deleteObject(bucket, row.objectKey); } catch { /* 아래에서 행을 지운다 */ }
    }
    await prisma.profileImage.deleteMany({ where: { userId, slot: target.slot } });

    noStore(res);
    return ok(res, { deleted: true, imageId: req.params.imageId });
  } catch (error) { next(error); }
});

// multer 가 한도를 넘겨 거절한 경우를 명세의 코드로 바꾼다.
// 이 처리가 없으면 공통 오류 처리기가 500 으로 묶어버려 클라이언트가 이유를 알 수 없다.
imagesRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return fail(res, 413, "IMAGE_TOO_LARGE", "사진은 10MB 이하만 올릴 수 있습니다.");
    }
    return fail(res, 400, "VALIDATION_ERROR", "사진 파일을 확인해 주세요.");
  }
  return next(error);
});
