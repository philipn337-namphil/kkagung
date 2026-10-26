/**
 * 부하 테스트용 대량 사용자 시드.
 *
 * 기능 시드(backend/prisma/seed.ts)와 분리한다. 기능 테스트는 시드 행 수를 세기 때문에
 * 여기서 만든 사용자가 섞이면 그 테스트가 깨진다. 이 스크립트가 만든 계정은 모두
 * @kkagung.load 도메인을 쓰며 --clean 으로 한 번에 지운다.
 *
 *   node infra/loadtest/seed-load.mjs --count 2000
 *   node infra/loadtest/seed-load.mjs --clean
 *
 * DATABASE_URL 이 필요하다. 운영 DB 를 가리키면 실행을 거부한다.
 */
import { PrismaClient } from "../../backend/node_modules/@prisma/client/index.js";

const LOAD_DOMAIN = "@kkagung.load";
const BATCH = 500;

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const has = (name) => process.argv.includes(name);

const assertDisposableDatabase = () => {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error("운영 환경 설정으로는 실행하지 않는다.");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없다.");
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && process.env.ALLOW_REMOTE_LOAD_SEED !== "true") {
    throw new Error(`원격 호스트(${host})에는 시드하지 않는다. 필요하면 ALLOW_REMOTE_LOAD_SEED=true 로 실행할 것.`);
  }
};

const REGIONS = ["SEOUL_MAPO", "SEOUL_JONGNO", "SEOUL_GANGNAM", "SEOUL_YONGSAN", "SEOUL_SEODAEMUN", "BUSAN_HAEUNDAE"];
const JOBS = ["STUDENT", "OFFICE_WORKER", "FREELANCER", "SELF_EMPLOYED", "OTHER"];
const MBTI = ["ENFP", "INFP", "ESTJ", "ISTJ", "ENTP", "INTJ", "ESFJ", "ISFP"];

const prisma = new PrismaClient();

const clean = async () => {
  const { count } = await prisma.user.deleteMany({ where: { email: { endsWith: LOAD_DOMAIN } } });
  console.log(`부하용 계정 ${count}개 삭제`);
};

const seed = async (total) => {
  const existing = await prisma.user.count({ where: { email: { endsWith: LOAD_DOMAIN } } });
  if (existing > 0) {
    console.log(`이미 ${existing}개가 있다. 다시 만들기 전에 --clean 으로 지운다.`);
    await clean();
  }

  const started = Date.now();
  for (let offset = 0; offset < total; offset += BATCH) {
    const size = Math.min(BATCH, total - offset);
    // 사용자 → 프로필·선호·이미지 순서로 넣는다. createMany 는 관계를 만들지 못해 id 를 먼저 받는다.
    await prisma.user.createMany({
      data: Array.from({ length: size }, (_, i) => ({
        email: `load-${String(offset + i).padStart(6, "0")}${LOAD_DOMAIN}`,
        passwordHash: "load-test-no-login",
        adultVerifiedAt: new Date(),
      })),
    });
    const created = await prisma.user.findMany({
      where: { email: { endsWith: LOAD_DOMAIN } },
      select: { id: true, email: true },
      orderBy: { id: "desc" },
      take: size,
    });

    const profiles = [];
    const preferences = [];
    const images = [];
    for (const user of created) {
      const n = Number(user.email.slice(5, 11));
      // 성별을 반씩 섞고 선호를 서로 반대로 두어 상호 조건이 실제로 맞물리게 한다.
      const male = n % 2 === 0;
      const age = 20 + (n % 15);
      profiles.push({
        userId: user.id,
        displayName: `부하${n}`,
        birthDate: new Date(Date.UTC(2026 - age, (n % 12), 1 + (n % 27))),
        gender: male ? "MALE" : "FEMALE",
        regionCode: REGIONS[n % REGIONS.length],
        heightCm: 155 + (n % 35),
        jobCategory: JOBS[n % JOBS.length],
        mbti: MBTI[n % MBTI.length],
        profileCompletedAt: new Date(),
      });
      preferences.push({
        userId: user.id,
        preferredGender: male ? "FEMALE" : "MALE",
        minAge: 19,
        maxAge: 45,
        regionScope: ["ANY"],
      });
      // 공개 이미지가 있어야 추천 후보가 된다. 실제 객체는 만들지 않고 행만 둔다.
      images.push({
        userId: user.id, slot: 1, imageType: "BLURRED_PUBLIC",
        objectKey: `profiles/blur/load/${n}.webp`, generationStatus: "DONE",
        byteSize: 1024, width: 480, height: 480, processedAt: new Date(),
      });
    }
    await prisma.userProfile.createMany({ data: profiles });
    await prisma.userPreference.createMany({ data: preferences });
    await prisma.profileImage.createMany({ data: images });
    process.stdout.write(`\r  ${Math.min(offset + size, total)} / ${total}`);
  }
  console.log(`\n부하용 계정 ${total}개 생성 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
};

assertDisposableDatabase();
if (has("--clean")) await clean();
else await seed(Number(arg("--count", "2000")));
await prisma.$disconnect();
