import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { fortuneDateOf } from "./recommendation.js";

// docs/README.md 의 "선착순 N명(기본 100명)" 기준값이다. 관리자 설정이 들어오면 그 값을 쓴다.
const DEFAULT_TOTAL_COUNT = 100;

export type TicketRow = { id: bigint; status: string; expiresAt: Date; usedAt: Date | null; grantedRank: number | null };

// 새로고침권은 다음 날 오전 8시(KST)에 만료된다. 서비스 날짜 D 의 다음 날 08:00 KST = D T23:00Z 다.
export const ticketExpiresAt = (serviceDate: string) => new Date(`${serviceDate}T23:00:00Z`);

export const readRefreshTicket = (userId: bigint, serviceDate: string) =>
  prisma.refreshToken.findUnique({
    where: { userId_tokenDate: { userId, tokenDate: fortuneDateOf(serviceDate) } },
    select: { id: true, status: true, expiresAt: true, usedAt: true, grantedRank: true },
  });

const ensureInventory = async (serviceDate: string) => {
  const existing = await prisma.dailyRefreshInventory.findUnique({ where: { serviceDate: fortuneDateOf(serviceDate) } });
  if (existing) return;
  try {
    await prisma.dailyRefreshInventory.create({
      data: { serviceDate: fortuneDateOf(serviceDate), totalCount: DEFAULT_TOTAL_COUNT, remainingCount: DEFAULT_TOTAL_COUNT },
    });
  } catch (error) {
    // 같은 순간의 다른 요청이 먼저 만들었다면 그 행을 쓴다.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }
};

/**
 * 선착순 지급을 시도한다. 재고가 없으면 오류가 아니라 지급하지 않은 상태로 돌려준다.
 * 이미 그날 권이 있으면 다시 지급하지 않는다.
 */
export const grantRefreshTicket = async (userId: bigint, serviceDate: string): Promise<{ token: TicketRow | null; granted: boolean }> => {
  const existing = await readRefreshTicket(userId, serviceDate);
  if (existing) return { token: existing, granted: false };

  await ensureInventory(serviceDate);
  const tokenDate = fortuneDateOf(serviceDate);

  try {
    return await prisma.$transaction(async (tx) => {
      // 재고 행을 잠근 뒤 차감해야 동시 요청에도 설정한 개수를 넘겨 발급하지 않는다.
      const locked = await tx.$queryRaw<{ remaining_count: number; granted_count: number }[]>`
        SELECT remaining_count, granted_count FROM daily_refresh_inventory WHERE service_date = ${serviceDate} FOR UPDATE
      `;
      const row = locked[0];
      if (!row || Number(row.remaining_count) <= 0) return { token: null, granted: false };

      const grantedRank = Number(row.granted_count) + 1;
      await tx.dailyRefreshInventory.update({
        where: { serviceDate: tokenDate },
        data: { remainingCount: { decrement: 1 }, grantedCount: { increment: 1 } },
      });
      const token = await tx.refreshToken.create({
        data: { userId, tokenDate, status: "AVAILABLE", expiresAt: ticketExpiresAt(serviceDate), grantedRank },
        select: { id: true, status: true, expiresAt: true, usedAt: true, grantedRank: true },
      });
      return { token, granted: true };
    });
  } catch (error) {
    // 같은 사용자의 동시 요청이 먼저 발급했다면 유니크 충돌이 난다. 차감은 롤백되므로 기존 권을 읽어 돌려준다.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    return { token: await readRefreshTicket(userId, serviceDate), granted: false };
  }
};

export type ConsumeResult = { token: TicketRow } | { errorCode: "REFRESH_TOKEN_NOT_FOUND" | "REFRESH_TOKEN_EXPIRED" | "REFRESH_TOKEN_ALREADY_USED" };

/** 새로고침권을 한 번만 사용 처리한다. 동시에 눌러도 한 요청만 성공한다. */
export const consumeRefreshTicket = async (userId: bigint, serviceDate: string, now: Date): Promise<ConsumeResult> => {
  const token = await readRefreshTicket(userId, serviceDate);
  if (!token) return { errorCode: "REFRESH_TOKEN_NOT_FOUND" };
  if (token.status === "USED") return { errorCode: "REFRESH_TOKEN_ALREADY_USED" };
  if (token.status === "EXPIRED" || token.expiresAt.getTime() <= now.getTime()) return { errorCode: "REFRESH_TOKEN_EXPIRED" };

  // 조건부 UPDATE 의 영향 행 수로 승자를 가린다.
  const changed = await prisma.refreshToken.updateMany({ where: { id: token.id, status: "AVAILABLE" }, data: { status: "USED", usedAt: now } });
  if (changed.count !== 1) return { errorCode: "REFRESH_TOKEN_ALREADY_USED" };

  return { token: { ...token, status: "USED", usedAt: now } };
};
