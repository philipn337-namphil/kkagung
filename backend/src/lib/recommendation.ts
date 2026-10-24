import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

// 서비스 하루는 한국 시간 오전 8시부터다. 8시 이전 요청은 전날 서비스 날짜에 속한다.
const KST_OFFSET_HOURS = 9;
const SERVICE_DAY_START_HOUR = 8;
export const serviceDateOf = (now: Date) =>
  new Date(now.getTime() + (KST_OFFSET_HOURS - SERVICE_DAY_START_HOUR) * 60 * 60 * 1000).toISOString().slice(0, 10);
export const fortuneDateOf = (serviceDate: string) => new Date(`${serviceDate}T00:00:00Z`);

// 추천 목록에서는 정지·탈퇴 외에 추천 제외 제재도 빼야 하므로 남는 상태는 이 둘이다.
const RECOMMENDABLE_STATUS = ["ACTIVE", "CHAT_RESTRICTED"] as const;
const ANY = "ANY";

// reason_code 값은 문서에 목록이 없다. 선택 조건까지 맞은 추천과, 후보가 부족해 선택 조건을
// 완화한 추천을 구분할 수 있는 최소 집합으로 둔다. 화면 문구는 여기서 만든다.
const REASON = {
  PREFERENCE_MATCH: "선호 조건이 일치해요.",
  PREFERENCE_RELAXED: "조건을 조금 넓혀 찾은 추천이에요.",
  RECEIVED_HEART: "나에게 하트를 보냈어요.",
  CHAT_REQUEST_RECEIVED: "채팅을 요청했어요.",
  CHAT_REQUEST_SENT: "내가 채팅을 요청했어요.",
  CHAT_PARTNER: "채팅 중인 상대예요.",
} as const;
type ReasonCode = keyof typeof REASON;
const reasonText = (code: string) => REASON[code as ReasonCode] ?? REASON.PREFERENCE_MATCH;

export type PublicCard = {
  userId: string;
  displayName: string;
  age: number;
  gender: string;
  regionLabel: string;
  heightCm: number;
  jobCategory: string;
  mbti: string;
  animalFace: string | null;
  badges: string[];
  publicImage: { url: string; type: string } | null;
  recommendReason: string;
};

const ageOn = (birthDate: Date, serviceDate: string) => {
  const [year, month, day] = serviceDate.split("-").map(Number);
  let age = year - birthDate.getUTCFullYear();
  const monthDiff = month - (birthDate.getUTCMonth() + 1);
  if (monthDiff < 0 || (monthDiff === 0 && day < birthDate.getUTCDate())) age -= 1;
  return age;
};

// 같은 뷰어·같은 서비스 날짜면 항상 같은 순서가 나오도록 해시로 정렬한다.
const orderKey = (viewerId: bigint, serviceDate: string, targetId: bigint) =>
  createHash("sha256").update(`${viewerId}:${serviceDate}:${targetId}`).digest("hex");

const matchesOptional = (value: string | null, wanted: string | null) => wanted === null || wanted === ANY || value === wanted;

type Candidate = { id: bigint; profile: NonNullable<Awaited<ReturnType<typeof loadViewer>>>["profile"]; preference: NonNullable<Awaited<ReturnType<typeof loadViewer>>>["preference"] };

const loadViewer = (userId: bigint) =>
  prisma.user.findUnique({ where: { id: userId }, select: { id: true, profile: true, preference: true } });

const excludedIds = async (viewerId: bigint, recommendationDate: Date) => {
  const excluded = new Set<string>();
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: viewerId }, { targetUserId: viewerId }] },
    select: { blockerId: true, targetUserId: true },
  });
  for (const block of blocks) {
    excluded.add(block.blockerId.toString());
    excluded.add(block.targetUserId.toString());
  }
  const shown = await prisma.recommendationItem.findMany({ where: { viewerId, recommendationDate }, select: { targetUserId: true } });
  for (const item of shown) excluded.add(item.targetUserId.toString());
  return excluded;
};

const pickTargets = async (viewerId: bigint, serviceDate: string, recommendationDate: Date, cardCount: number) => {
  const viewer = await loadViewer(viewerId);
  if (!viewer?.profile || !viewer.preference) return [];

  const viewerAge = ageOn(viewer.profile.birthDate, serviceDate);
  const preference = viewer.preference;
  const regionScope = Array.isArray(preference.regionScope) ? (preference.regionScope as string[]) : [];
  const anyRegion = regionScope.length === 0 || regionScope.includes(ANY);
  const excluded = await excludedIds(viewerId, recommendationDate);

  const candidates = (await prisma.user.findMany({
    where: { id: { not: viewerId }, status: { in: [...RECOMMENDABLE_STATUS] }, profile: { isNot: null }, preference: { isNot: null } },
    select: { id: true, profile: true, preference: true },
  })) as Candidate[];

  // 성별·나이 상호 조건, 지역, 차단, 정지·탈퇴·추천 제외는 완화하지 않는 조건이다.
  const hardMatched = candidates.filter((candidate) => {
    const profile = candidate.profile!;
    const theirPreference = candidate.preference!;
    if (excluded.has(candidate.id.toString())) return false;
    if (profile.profileCompletedAt === null) return false;
    if (preference.preferredGender !== profile.gender) return false;
    if (theirPreference.preferredGender !== viewer.profile!.gender) return false;
    const targetAge = ageOn(profile.birthDate, serviceDate);
    if (targetAge < preference.minAge || targetAge > preference.maxAge) return false;
    if (viewerAge < theirPreference.minAge || viewerAge > theirPreference.maxAge) return false;
    if (!anyRegion && !regionScope.includes(profile.regionCode)) return false;
    return true;
  });

  // 선택 조건은 후보가 부족할 때 완화한다.
  const strictMatched = hardMatched.filter((candidate) => {
    const profile = candidate.profile!;
    if (!matchesOptional(profile.energyType, preference.energyType)) return false;
    if (!matchesOptional(profile.smokingStatus, preference.smokingStatus)) return false;
    if (!matchesOptional(profile.tattooStatus, preference.tattooStatus)) return false;
    if (!matchesOptional(profile.militaryService, preference.militaryService)) return false;
    if (preference.animalFace !== null && profile.animalFace !== preference.animalFace) return false;
    if (preference.minHeightCm !== null && profile.heightCm < preference.minHeightCm) return false;
    return true;
  });

  const byOrderKey = (left: Candidate, right: Candidate) =>
    orderKey(viewerId, serviceDate, left.id).localeCompare(orderKey(viewerId, serviceDate, right.id));

  const picked: { id: bigint; reasonCode: ReasonCode }[] = strictMatched
    .slice()
    .sort(byOrderKey)
    .slice(0, cardCount)
    .map((candidate) => ({ id: candidate.id, reasonCode: "PREFERENCE_MATCH" as const }));

  if (picked.length < cardCount) {
    const chosen = new Set(picked.map((entry) => entry.id.toString()));
    const relaxed = hardMatched
      .filter((candidate) => !chosen.has(candidate.id.toString()))
      .sort(byOrderKey)
      .slice(0, cardCount - picked.length)
      .map((candidate) => ({ id: candidate.id, reasonCode: "PREFERENCE_RELAXED" as const }));
    picked.push(...relaxed);
  }

  return picked;
};

// 공개용 이미지만 쓴다. 원본(ORIGINAL_PRIVATE)은 조회하지도, 응답에 넣지도 않는다.
const publicImageOf = (images: { imageType: string; objectKey: string }[]) => {
  const endpoint = (process.env.OBJECT_STORAGE_ENDPOINT ?? "").replace(/\/$/, "");
  const bucket = process.env.OBJECT_STORAGE_BUCKET_PUBLIC ?? "";
  const chosen = images.find((image) => image.imageType === "AI_PUBLIC") ?? images.find((image) => image.imageType === "BLURRED_PUBLIC");
  // 기준 주소가 설정되지 않은 환경에서는 URL 을 만들 수 없으므로 null 을 준다.
  if (!chosen || endpoint === "" || bucket === "") return null;
  return { url: `${endpoint}/${bucket}/${chosen.objectKey}`, type: chosen.imageType };
};

// 하트·채팅 목록도 같은 공개 카드 모양을 쓴다. 변환을 한 곳에만 두기 위해 내보낸다.
export const buildPublicCards = async (viewerId: bigint, serviceDate: string, items: { targetUserId: bigint; reasonCode: string }[]) => {
  if (items.length === 0) return [];
  const excluded = new Set<string>();
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: viewerId }, { targetUserId: viewerId }] },
    select: { blockerId: true, targetUserId: true },
  });
  for (const block of blocks) {
    excluded.add(block.blockerId.toString());
    excluded.add(block.targetUserId.toString());
  }

  const targets = await prisma.user.findMany({
    where: { id: { in: items.map((item) => item.targetUserId) }, status: { in: [...RECOMMENDABLE_STATUS] } },
    select: {
      id: true,
      profile: true,
      profileImages: { where: { imageType: { in: ["AI_PUBLIC", "BLURRED_PUBLIC"] }, generationStatus: "DONE" }, select: { imageType: true, objectKey: true } },
    },
  });
  const byId = new Map(targets.map((target) => [target.id.toString(), target]));

  const cards: PublicCard[] = [];
  for (const item of items) {
    // 카드를 만든 뒤 상태가 바뀐 상대는 응답 시점에 다시 걸러낸다.
    const target = byId.get(item.targetUserId.toString());
    if (!target?.profile || excluded.has(item.targetUserId.toString())) continue;
    cards.push({
      userId: target.id.toString(),
      displayName: target.profile.displayName,
      age: ageOn(target.profile.birthDate, serviceDate),
      gender: target.profile.gender,
      regionLabel: target.profile.regionCode,
      heightCm: target.profile.heightCm,
      jobCategory: target.profile.jobCategory,
      mbti: target.profile.mbti,
      animalFace: target.profile.animalFace,
      badges: [],
      publicImage: publicImageOf(target.profileImages),
      recommendReason: reasonText(item.reasonCode),
    });
  }
  return cards;
};

// 새로고침을 썼다면 새로고침된 묶음만 돌려준다. 아직 안 썼다면 기본 묶음이다.
export const readDailyCards = async (viewerId: bigint, serviceDate: string) => {
  const recommendationDate = fortuneDateOf(serviceDate);
  const items = await prisma.recommendationItem.findMany({
    where: { viewerId, recommendationDate },
    orderBy: { displayOrder: "asc" },
    select: { targetUserId: true, reasonCode: true, sourceType: true },
  });
  const refreshed = items.filter((item) => item.sourceType === "REFRESH");
  const bundle = refreshed.length > 0 ? refreshed : items;
  return { sourceType: refreshed.length > 0 ? "REFRESH" : "INITIAL", cards: await buildPublicCards(viewerId, serviceDate, bundle) };
};

/** 새로고침으로 보여줄 새 후보를 고른다. 저장도, 권 소비도 하지 않는다. */
export const previewRefreshTargets = (viewerId: bigint, serviceDate: string, cardCount: number) =>
  pickTargets(viewerId, serviceDate, fortuneDateOf(serviceDate), cardCount);

/** 고른 후보를 REFRESH 묶음으로 저장하고 그 묶음만 돌려준다. */
export const saveRefreshCards = async (viewerId: bigint, serviceDate: string, picked: { id: bigint; reasonCode: string }[]) => {
  const recommendationDate = fortuneDateOf(serviceDate);
  if (picked.length > 0) {
    const highest = await prisma.recommendationItem.aggregate({ where: { viewerId, recommendationDate }, _max: { displayOrder: true } });
    const baseOrder = highest._max.displayOrder ?? 0;
    try {
      await prisma.recommendationItem.createMany({
        data: picked.map((entry, index) => ({
          viewerId,
          targetUserId: entry.id,
          recommendationDate,
          sourceType: "REFRESH" as const,
          displayOrder: baseOrder + index + 1,
          reasonCode: entry.reasonCode,
        })),
      });
    } catch (error) {
      // 같은 순간의 다른 요청이 먼저 저장했다면 유니크 충돌이 난다. 그 결과를 그대로 쓴다.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
  }

  const refreshed = await prisma.recommendationItem.findMany({
    where: { viewerId, recommendationDate, sourceType: "REFRESH" },
    orderBy: { displayOrder: "asc" },
    select: { targetUserId: true, reasonCode: true },
  });
  return { sourceType: "REFRESH", cards: await buildPublicCards(viewerId, serviceDate, refreshed) };
};

export const ensureDailyCards = async (viewerId: bigint, serviceDate: string, cardCount: number) => {
  const recommendationDate = new Date(`${serviceDate}T00:00:00Z`);
  const existing = await prisma.recommendationItem.count({ where: { viewerId, recommendationDate } });

  if (existing === 0) {
    const picked = await pickTargets(viewerId, serviceDate, recommendationDate, cardCount);
    if (picked.length > 0) {
      try {
        await prisma.recommendationItem.createMany({
          data: picked.map((entry, index) => ({
            viewerId,
            targetUserId: entry.id,
            recommendationDate,
            sourceType: "INITIAL" as const,
            displayOrder: index + 1,
            reasonCode: entry.reasonCode,
          })),
        });
      } catch (error) {
        // 같은 순간의 다른 요청이 먼저 저장했다면 유니크 충돌이 난다. 그 결과를 그대로 쓴다.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      }
    }
  }

  return readDailyCards(viewerId, serviceDate);
};

/**
 * 카드에 이미 하트를 보냈는지, 채팅을 요청했는지 표시한다.
 * 상대가 무시한 요청도 발신자에게는 '요청함'으로 남겨, 무시 사실을 알리지 않는다.
 */
export const interactionMarks = async (viewerId: bigint, targetIds: bigint[]) => {
  if (targetIds.length === 0) return { heartedUserIds: [], requestedUserIds: [] };
  const [hearts, requests] = await Promise.all([
    prisma.heart.findMany({ where: { senderId: viewerId, receiverId: { in: targetIds }, canceledAt: null }, select: { receiverId: true } }),
    prisma.chatRequest.findMany({ where: { senderId: viewerId, receiverId: { in: targetIds } }, select: { receiverId: true } }),
  ]);
  return {
    heartedUserIds: hearts.map((heart) => heart.receiverId.toString()),
    requestedUserIds: requests.map((request) => request.receiverId.toString()),
  };
};
