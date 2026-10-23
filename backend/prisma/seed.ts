import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const passwordHash = await bcrypt.hash("kkagung123!", 12);
  await prisma.user.upsert({ where: { email: "admin@kkagung.local" }, update: {}, create: { email: "admin@kkagung.local", passwordHash, role: "ADMIN", adultVerifiedAt: new Date() } });
  await prisma.user.upsert({ where: { email: "demo@kkagung.local" }, update: {}, create: { email: "demo@kkagung.local", passwordHash, adultVerifiedAt: new Date() } });
  console.log("Seed complete: admin@kkagung.local / demo@kkagung.local (password: kkagung123!)");
}
main().finally(() => prisma.$disconnect());
