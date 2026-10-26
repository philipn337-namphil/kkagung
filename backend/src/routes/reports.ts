import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../lib/response.js";
import { prisma } from "../prisma.js";

const UNAVAILABLE_STATUS = ["SUSPENDED", "WITHDRAWN"] as const;
const OPEN_STATUS = ["PENDING", "REVIEWING"] as const;

const reportSchema = z.object({
  targetType: z.enum(["USER", "MESSAGE"]),
  targetId: z.string().regex(/^\d+$/),
  reasonCode: z.enum(["SPAM", "ABUSE", "SEXUAL", "FAKE_PROFILE", "UNDERAGE", "OTHER"]),
  detail: z.string().max(500).nullable().optional(),
});

export const reportsRouter = Router();

reportsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const reporterId = req.auth!.userId;
    const input = reportSchema.parse(req.body);
    const targetId = BigInt(input.targetId);

    const me = await prisma.user.findUnique({ where: { id: reporterId }, select: { status: true } });
    if (!me) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if ((UNAVAILABLE_STATUS as readonly string[]).includes(me.status)) return fail(res, 403, "SUSPENDED_USER", "이용이 정지된 계정입니다.");

    if (input.targetType === "USER") {
      if (targetId === reporterId) return fail(res, 400, "SELF_ACTION_NOT_ALLOWED", "자신은 신고할 수 없습니다.");
      const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
      if (!target) return fail(res, 404, "RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다.");
    } else {
      // 메시지를 신고하려면 내가 그 방의 참여자여야 한다.
      const message = await prisma.chatMessage.findUnique({ where: { id: targetId }, select: { roomId: true, senderId: true } });
      if (!message) return fail(res, 404, "RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다.");
      if (message.senderId === reporterId) return fail(res, 400, "SELF_ACTION_NOT_ALLOWED", "자신의 메시지는 신고할 수 없습니다.");
      const member = await prisma.chatRoomMember.count({ where: { roomId: message.roomId, userId: reporterId } });
      if (member === 0) return fail(res, 404, "RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다.");
    }

    const duplicateWhere = {
      reporterId,
      targetType: input.targetType,
      targetId,
      reasonCode: input.reasonCode,
      status: { in: [...OPEN_STATUS] },
    };

    // 부분 유일 인덱스를 쓸 수 없어, 신고자 행을 잠가 같은 대상·사유의 중복 접수를 막는다.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${reporterId} FOR UPDATE`;
      const open = await tx.report.findFirst({ where: duplicateWhere, select: { id: true } });
      if (open) return { duplicate: true as const };
      const row = await tx.report.create({
        data: {
          reporterId,
          targetType: input.targetType,
          targetId,
          reasonCode: input.reasonCode,
          detail: input.detail ?? null,
        },
        select: { id: true, status: true, createdAt: true },
      });
      return { row };
    });

    if ("duplicate" in result) return fail(res, 409, "REPORT_ALREADY_EXISTS", "이미 접수된 신고가 처리 중입니다.");

    // 처리 결과·담당자는 신고자에게 알리지 않는다.
    return ok(res, { reportId: result.row.id.toString(), status: result.row.status, createdAt: result.row.createdAt }, 201);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return fail(res, 409, "REPORT_ALREADY_EXISTS", "이미 접수된 신고가 처리 중입니다.");
    }
    next(error);
  }
});
