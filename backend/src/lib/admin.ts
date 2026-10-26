import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { fail } from "./response.js";
import { prisma } from "../prisma.js";
import { clientIp } from "./clientIp.js";

/**
 * 토큰의 역할 값만 믿지 않고, 요청 시점의 DB 역할과 계정 상태를 다시 확인한다.
 * 일반 사용자·권한 회수·정지·탈퇴는 모두 거부한다.
 */
export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const admin = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, role: true, status: true } });
    if (!admin) return fail(res, 401, "UNAUTHORIZED", "로그인이 필요합니다.");
    if (admin.role !== "ADMIN" || admin.status !== "ACTIVE") return fail(res, 403, "FORBIDDEN", "관리자 권한이 필요합니다.");
    if (!isAllowedAddress(req)) return fail(res, 403, "FORBIDDEN", "허용되지 않은 접속 경로입니다.");
    next();
  } catch (error) { next(error); }
};

/**
 * 관리자 허용 IP 목록. 사용자가 보낸 X-Forwarded-For 는 신뢰하지 않고 실제 접속 주소만 본다.
 * 목록이 비어 있으면 운영에서는 전부 막고, 그 밖의 환경에서는 제한하지 않는다.
 */
export const isAllowedAddress = (req: Request) => {
  const raw = (process.env.ADMIN_ALLOWED_IP_CIDRS ?? "").trim();
  if (raw === "") return process.env.APP_ENV !== "production" && process.env.NODE_ENV !== "production";
  const address = clientIp(req);
  const entries = raw.split(",").map((entry) => entry.trim());
  // A malformed entry must never become /0 or be ignored beside a valid entry.
  if (!isIP(address) || !entries.every(validEntry)) return false;
  return entries.some((entry) => matchesEntry(address, entry));
};

const validEntry = (entry: string) => {
  const parts = entry.split("/");
  if (parts.length === 1) return isIP(parts[0]) !== 0;
  return parts.length === 2 && isIP(parts[0]) === 4
    && /^(0|[1-9]\d?)$/.test(parts[1]) && Number(parts[1]) <= 32;
};

const matchesEntry = (address: string, entry: string) => {
  if (!entry.includes("/")) return address === entry;
  const [network, bitsRaw] = entry.split("/");
  const bits = Number(bitsRaw);
  const toInt = (value: string) => value.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  if (isIP(address) !== 4 || isIP(network) !== 4) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (toInt(address) & mask) === (toInt(network) & mask);
};

export type AuditInput = {
  adminId: bigint;
  action: string;
  targetType: string;
  targetId: bigint;
  beforeValue?: Prisma.InputJsonValue;
  afterValue?: Prisma.InputJsonValue;
};

/** 관리자 행위는 본 변경과 같은 트랜잭션에서 기록한다. 토큰·비밀번호·본문은 담지 않는다. */
export const writeAuditLog = (tx: Prisma.TransactionClient, input: AuditInput) =>
  tx.adminAuditLog.create({
    data: {
      adminId: input.adminId,
      requestId: randomUUID(),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      beforeValue: input.beforeValue,
      afterValue: input.afterValue,
      result: "SUCCESS",
    },
    select: { id: true },
  });
