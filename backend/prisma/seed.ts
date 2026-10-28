import bcrypt from "bcryptjs";
import sharp from "sharp";
import { PrismaClient } from "@prisma/client";
import { deleteObject, privateBucket, publicBucket, putObject, storageReady } from "../src/lib/objectStorage.js";
const prisma = new PrismaClient();

type Gender = "MALE" | "FEMALE";
type JobCategory = "STUDENT" | "OFFICE_WORKER" | "FREELANCER" | "SELF_EMPLOYED";
type EnergyType = "EGEN" | "TETO";

type SeedProfile = {
  seedNo: number;
  displayName: string;
  birthDate: string;
  gender: Gender;
  regionCode: string;
  heightCm: number;
  jobCategory: JobCategory;
  mbti: string;
  energyType: EnergyType;
  intro: string;
};

type SeedAccount = {
  email: string;
  role: "USER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  profile: SeedProfile | null;
};

// 모두 가상 계정이다. 실제 사람 정보를 넣지 않는다.
const accounts: SeedAccount[] = [
  { email: "admin@kkagung.local", role: "ADMIN", status: "ACTIVE", profile: null },
  {
    email: "demo@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 2, displayName: "테스트남1", birthDate: "1995-03-14", gender: "MALE", regionCode: "SEOUL_DONGDAEMUN", heightCm: 178, jobCategory: "STUDENT", mbti: "INTJ", energyType: "EGEN", intro: "조용한 전시 산책을 좋아하는 테스트 계정입니다." },
  },
  {
    email: "user1@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 3, displayName: "테스트남2", birthDate: "1996-07-22", gender: "MALE", regionCode: "SEOUL_MAPO", heightCm: 172, jobCategory: "OFFICE_WORKER", mbti: "ENFP", energyType: "TETO", intro: "주말 러닝과 새 식당 찾기를 즐기는 테스트 계정입니다." },
  },
  {
    email: "user2@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 4, displayName: "테스트남3", birthDate: "1997-11-02", gender: "MALE", regionCode: "SEOUL_GWANGJIN", heightCm: 183, jobCategory: "FREELANCER", mbti: "ISTP", energyType: "EGEN", intro: "사진과 자전거를 좋아하는 테스트 계정입니다." },
  },
  {
    email: "user3@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 5, displayName: "테스트남4", birthDate: "1998-05-09", gender: "MALE", regionCode: "SEOUL_SEONGDONG", heightCm: 168, jobCategory: "SELF_EMPLOYED", mbti: "ESFJ", energyType: "TETO", intro: "작은 가게를 운영하는 테스트 계정입니다." },
  },
  {
    email: "user4@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 6, displayName: "테스트여1", birthDate: "1999-02-18", gender: "FEMALE", regionCode: "SEOUL_SEODAEMUN", heightCm: 162, jobCategory: "STUDENT", mbti: "INFP", energyType: "EGEN", intro: "영화 이야기 나누기를 좋아하는 테스트 계정입니다." },
  },
  {
    email: "user5@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 7, displayName: "테스트여2", birthDate: "2000-09-27", gender: "FEMALE", regionCode: "SEOUL_JONGNO", heightCm: 157, jobCategory: "OFFICE_WORKER", mbti: "ESTJ", energyType: "TETO", intro: "퇴근 후 베이킹을 즐기는 테스트 계정입니다." },
  },
  {
    email: "user6@kkagung.local", role: "USER", status: "ACTIVE",
    profile: { seedNo: 8, displayName: "테스트여3", birthDate: "2001-06-05", gender: "FEMALE", regionCode: "SEOUL_YONGSAN", heightCm: 169, jobCategory: "FREELANCER", mbti: "ENTP", energyType: "EGEN", intro: "그림 작업과 산책을 좋아하는 테스트 계정입니다." },
  },
  {
    email: "suspended@kkagung.local", role: "USER", status: "SUSPENDED",
    profile: { seedNo: 9, displayName: "테스트여4", birthDate: "2002-01-30", gender: "FEMALE", regionCode: "SEOUL_GANGBUK", heightCm: 165, jobCategory: "SELF_EMPLOYED", mbti: "ISFJ", energyType: "TETO", intro: "제재 상태 확인용 테스트 계정입니다." },
  },
];

// object key 에는 이름·이메일·원래 파일명을 넣지 않고 가짜 식별자만 쓴다.
// AI 는 PENDING 으로 둔다(D-02). 실제 사용자가 올렸을 때와 같은 상태다.
// 시드만 DONE 으로 두면 구현하지 않은 AI 변환이 동작하는 것처럼 보이고, 카드에
// 흐림본 대신 선명한 사진이 나가 "수락 전에는 흐림만 공개" 라는 규칙과 어긋난다.
const imageRows = (seedNo: number) => [
  { imageType: "ORIGINAL_PRIVATE" as const, objectKey: `originals/seed-${seedNo}-1.webp`, status: "DONE" as const },
  { imageType: "BLURRED_PUBLIC" as const, objectKey: `profiles/blurred/seed-${seedNo}-1.webp`, status: "DONE" as const },
  { imageType: "AI_PUBLIC" as const, objectKey: "", status: "PENDING" as const },
];

/**
 * 시드 계정의 자리 표시 사진. 사람 사진이 아니라 색이 다른 단색 도형이라 구분만 된다.
 * 행만 만들고 객체를 올리지 않으면 추천 카드가 전부 깨진 이미지로 뜬다.
 */
const placeholder = (seedNo: number, blur: boolean) => {
  const hue = (seedNo * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">`
    + `<rect width="1024" height="1024" fill="hsl(${hue} 55% 78%)"/>`
    + `<circle cx="512" cy="420" r="190" fill="hsl(${hue} 45% 58%)"/>`
    + `<rect x="232" y="690" width="560" height="320" rx="160" fill="hsl(${hue} 45% 58%)"/></svg>`;
  const image = sharp(Buffer.from(svg));
  return (blur ? image.blur(28) : image).webp({ quality: 80 }).toBuffer();
};

/** 저장소가 설정된 환경에서만 올린다. 설정이 없으면 행만 두고 넘어간다. */
const seedImageObject = async (imageType: string, objectKey: string, seedNo: number) => {
  if (!storageReady()) return;
  const isOriginal = imageType === "ORIGINAL_PRIVATE";
  const body = await placeholder(seedNo, imageType === "BLURRED_PUBLIC");
  await putObject(isOriginal ? privateBucket() : publicBucket(), objectKey, body, "image/webp");
};

async function main() {
  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD ?? "kkagung123!", 12);
  const now = new Date();

  for (const account of accounts) {
    const user = await prisma.user.upsert({
      where: { email: account.email },
      update: { passwordHash, role: account.role, status: account.status, adultVerifiedAt: now },
      create: { email: account.email, passwordHash, role: account.role, status: account.status, adultVerifiedAt: now },
    });

    if (!account.profile) continue;
    const p = account.profile;

    const profileData = {
      displayName: p.displayName,
      birthDate: new Date(`${p.birthDate}T00:00:00Z`),
      gender: p.gender,
      regionCode: p.regionCode,
      heightCm: p.heightCm,
      jobCategory: p.jobCategory,
      mbti: p.mbti,
      energyType: p.energyType,
      animalFace: null,
      celebrityLookalike: null,
      smokingStatus: null,
      tattooStatus: null,
      militaryService: null,
      intro: p.intro,
      profileCompletedAt: now,
    };
    await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: profileData,
      create: { userId: user.id, ...profileData },
    });

    const preferenceData = {
      preferredGender: (p.gender === "MALE" ? "FEMALE" : "MALE") as Gender,
      minAge: 24,
      maxAge: 36,
      regionScope: ["ANY"],
      energyType: "ANY" as const,
      animalFace: null,
      minHeightCm: null,
      smokingStatus: "ANY" as const,
      tattooStatus: "ANY" as const,
      militaryService: "ANY" as const,
    };
    await prisma.userPreference.upsert({
      where: { userId: user.id },
      update: preferenceData,
      create: { userId: user.id, ...preferenceData },
    });

    for (const row of imageRows(p.seedNo)) {
      // 다시 돌릴 때 앞선 시드가 올려 둔 객체가 남을 수 있다. 특히 AI 는 예전에 DONE 으로
      // 시드해 객체까지 올렸는데 지금은 PENDING + 빈 키라, 지우지 않으면 아무도 참조하지
      // 않는 객체가 공개 버킷에 남는다. 그 키가 공개 읽기로 열려 있으므로 치운다.
      const before = await prisma.profileImage.findUnique({
        where: { userId_slot_imageType: { userId: user.id, slot: 1, imageType: row.imageType } },
        select: { objectKey: true },
      });
      if (storageReady() && before !== null && before.objectKey !== "" && before.objectKey !== row.objectKey) {
        const bucket = row.imageType === "ORIGINAL_PRIVATE" ? privateBucket() : publicBucket();
        // 지우지 못해도 시드는 계속한다. 남은 객체는 수명 주기 정책으로 정리한다.
        try { await deleteObject(bucket, before.objectKey); } catch { /* 계속 */ }
      }

      // 올릴 객체가 없는 행(AI PENDING)은 건너뛴다.
      if (row.objectKey !== "") await seedImageObject(row.imageType, row.objectKey, p.seedNo);
      const pending = row.status === "PENDING";
      const imageData = {
        objectKey: row.objectKey,
        generationStatus: row.status,
        byteSize: pending ? 0 : 120000,
        width: pending ? 0 : 1024,
        height: pending ? 0 : 1024,
        processedAt: pending ? null : now,
        failedReasonCode: null,
      };
      await prisma.profileImage.upsert({
        where: { userId_slot_imageType: { userId: user.id, slot: 1, imageType: row.imageType } },
        update: imageData,
        create: { userId: user.id, slot: 1, imageType: row.imageType, ...imageData },
      });
    }
  }

  console.log(`Seed complete: 계정 ${accounts.length}개`);
  if (!storageReady()) console.log("  저장소 설정이 없어 사진 객체는 올리지 않았다. 카드는 자리 표시로 보인다.");
  for (const account of accounts) console.log(`  - ${account.email}`);
}

main().finally(() => prisma.$disconnect());
