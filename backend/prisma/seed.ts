import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
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
const imageRows = (seedNo: number) => [
  { imageType: "ORIGINAL_PRIVATE" as const, objectKey: `originals/seed-${seedNo}-1.webp` },
  { imageType: "AI_PUBLIC" as const, objectKey: `profiles/ai/seed-${seedNo}-1.webp` },
  { imageType: "BLURRED_PUBLIC" as const, objectKey: `profiles/blurred/seed-${seedNo}-1.webp` },
];

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
      const imageData = {
        objectKey: row.objectKey,
        generationStatus: "DONE" as const,
        byteSize: 120000,
        width: 1024,
        height: 1024,
        processedAt: now,
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
  for (const account of accounts) console.log(`  - ${account.email}`);
}

main().finally(() => prisma.$disconnect());
