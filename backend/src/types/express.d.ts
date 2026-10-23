import type { UserRole } from "@prisma/client";
declare global {
  namespace Express { interface Request { auth?: { userId: bigint; role: UserRole }; } }
}
export {};
