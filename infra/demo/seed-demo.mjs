/**
 * 발표 시연용 데이터.
 *
 * 기능 시드(backend/prisma/seed.ts)와 부하 시드(infra/loadtest/seed-load.mjs)를 건드리지
 * 않는다. 셋이 각자 도메인을 쓴다.
 *
 *   @kkagung.local   기능 시드. 테스트가 이 계정들을 세므로 손대지 않는다
 *   @kkagung.load    부하용. 측정이 끝나면 지운다
 *   @kkagung.demo    여기서 만드는 시연용
 *
 *   node infra/demo/seed-demo.mjs
 *   node infra/demo/seed-demo.mjs --clean
 *
 * 사진은 사람 사진이 아니다. 사람마다 색이 다른 아바타를 그려 올린다. 실제 사람 사진을
 * 시연에 쓰는 것은 그 사람의 동의 없이 쓰는 일이다.
 *
 * AI 사진은 PENDING 으로 둔다(D-02). 실제 사용자가 올렸을 때와 같은 상태다. 그래서 추천
 * 카드에는 흐림본이 나가고, 채팅 요청을 수락해야 원본이 보인다. 시연에서 보여줄 이야기가
 * 그것이다. 시드만 AI 를 DONE 으로 꾸미면 구현하지 않은 기능이 동작하는 것처럼 보인다.
 *
 * DATABASE_URL 과 OBJECT_STORAGE_* 가 필요하다. 저장소 설정이 없으면 사진 없이 만든다.
 */
// 저장소에서 바로 돌릴 때와 앱 이미지 안에 붙여 돌릴 때가 모두 필요하다.
// 부하 스크립트와 같은 이유다. NCP 에서는 Cloud DB 에 닿는 곳이 앱 서버뿐이다.
const dep = async (name, entry) => {
  try { return await import(name); }
  catch { return await import(new URL(`../../backend/node_modules/${name}/${entry}`, import.meta.url).href); }
};
/** 업로드는 애플리케이션과 같은 코드를 쓴다. 공개 버킷에 public-read 를 붙이는 규칙이 거기 있다. */
const loadStorage = async () => {
  for (const path of ["../../backend/dist/src/lib/objectStorage.js", "../dist/src/lib/objectStorage.js"]) {
    try { return await import(new URL(path, import.meta.url).href); } catch { /* 다음 경로 */ }
  }
  throw new Error("objectStorage 를 찾지 못했다. backend 를 먼저 빌드할 것(npm run build).");
};

const bcrypt = (await dep("bcryptjs", "index.js")).default;
const sharp = (await dep("sharp", "dist/index.mjs")).default;
const { PrismaClient } = await dep("@prisma/client", "index.js");
const { privateBucket, publicBucket, putObject, storageReady } = await loadStorage();

const DOMAIN = "@kkagung.demo";
const prisma = new PrismaClient();
const has = (name) => process.argv.includes(name);

/** 발표자가 로그인할 계정. 나머지는 이 사람에게 보일 상대다. */
const PRESENTER = "narae" + DOMAIN;
const ADMIN = "unjeong" + DOMAIN;

// 이름은 성을 뺀 이름만 받는다(docs/01). 카드에는 아예 나가지 않고, 수락된 채팅방에서만 보인다.
const people = [
  { id: "narae", name: "나래", gender: "MALE", age: 29, region: "SEOUL_MAPO", height: 177, job: "OFFICE_WORKER", mbti: "ENFP", animal: "강아지상", intro: "주말엔 성수동 카페 돌아다녀요. 같이 다닐 사람 찾습니다." },
  { id: "unjeong", name: "운정", gender: "FEMALE", age: 31, region: "SEOUL_JONGNO", height: 165, job: "OFFICE_WORKER", mbti: "ISTJ", animal: "고양이상", intro: "운영 담당 계정입니다.", role: "ADMIN" },

  { id: "jiwon", name: "지원", gender: "FEMALE", age: 27, region: "SEOUL_MAPO", height: 163, job: "OFFICE_WORKER", mbti: "INFP", animal: "고양이상", intro: "전시 보러 다니는 걸 좋아해요. 요즘은 도예 배우는 중." },
  { id: "haeun", name: "하은", gender: "FEMALE", age: 26, region: "SEOUL_SEODAEMUN", height: 160, job: "STUDENT", mbti: "ENFJ", animal: "토끼상", intro: "대학원 마지막 학기예요. 커피 한 잔 하면서 얘기해요." },
  { id: "seoyeon", name: "서연", gender: "FEMALE", age: 30, region: "SEOUL_GANGNAM", height: 168, job: "FREELANCER", mbti: "ENTP", animal: "여우상", intro: "디자인 일 합니다. 밤에 걷는 걸 좋아해요." },
  { id: "minseo", name: "민서", gender: "FEMALE", age: 28, region: "SEOUL_YONGSAN", height: 166, job: "OFFICE_WORKER", mbti: "ISFJ", animal: "사슴상", intro: "조용한 데서 책 읽는 주말을 좋아합니다." },
  { id: "yuna", name: "유나", gender: "FEMALE", age: 25, region: "SEOUL_MAPO", height: 158, job: "STUDENT", mbti: "ESFP", animal: "강아지상", intro: "러닝 크루 하고 있어요. 같이 뛰실 분!" },
  { id: "dain", name: "다인", gender: "FEMALE", age: 32, region: "SEOUL_JONGNO", height: 170, job: "SELF_EMPLOYED", mbti: "INTJ", animal: "고양이상", intro: "작은 가게 하나 합니다. 쉬는 날엔 영화관에 있어요." },
  { id: "ssol", name: "소을", gender: "FEMALE", age: 29, region: "BUSAN_HAEUNDAE", height: 162, job: "FREELANCER", mbti: "INFJ", animal: "토끼상", intro: "바다 근처 살아요. 사진 찍는 게 취미입니다." },
  { id: "chaewon", name: "채원", gender: "FEMALE", age: 27, region: "SEOUL_GANGNAM", height: 164, job: "OFFICE_WORKER", mbti: "ESTJ", animal: "여우상", intro: "계획 세우는 걸 좋아해요. 여행 같이 가실 분." },
  { id: "arin", name: "아린", gender: "FEMALE", age: 24, region: "SEOUL_SEODAEMUN", height: 159, job: "STUDENT", mbti: "ISFP", animal: "사슴상", intro: "그림 그려요. 조용한 사람입니다." },
  { id: "jimin", name: "지민", gender: "FEMALE", age: 33, region: "SEOUL_YONGSAN", height: 167, job: "OFFICE_WORKER", mbti: "ENTJ", animal: "고양이상", intro: "운동하고 맛있는 거 먹는 게 낙이에요." },
  { id: "nayeon", name: "나연", gender: "FEMALE", age: 26, region: "SEOUL_MAPO", height: 161, job: "FREELANCER", mbti: "INTP", animal: "토끼상", intro: "번역 일 합니다. 집에서 보내는 시간이 많아요." },

  { id: "junho", name: "준호", gender: "MALE", age: 30, region: "SEOUL_GANGNAM", height: 180, job: "OFFICE_WORKER", mbti: "ISTP", animal: "늑대상", intro: "주말마다 등산 갑니다." },
  { id: "taemin", name: "태민", gender: "MALE", age: 28, region: "SEOUL_MAPO", height: 175, job: "FREELANCER", mbti: "ENFP", animal: "강아지상", intro: "음악 작업 해요. 공연 자주 보러 다닙니다." },
  { id: "doyun", name: "도윤", gender: "MALE", age: 32, region: "SEOUL_JONGNO", height: 178, job: "SELF_EMPLOYED", mbti: "ESTJ", animal: "곰상", intro: "요리하는 걸 좋아합니다. 집밥 잘해요." },
  { id: "siwoo", name: "시우", gender: "MALE", age: 26, region: "SEOUL_SEODAEMUN", height: 173, job: "STUDENT", mbti: "INFJ", animal: "고양이상", intro: "대학원생입니다. 산책 좋아해요." },
  { id: "hyunwoo", name: "현우", gender: "MALE", age: 34, region: "SEOUL_YONGSAN", height: 182, job: "OFFICE_WORKER", mbti: "INTJ", animal: "늑대상", intro: "주중엔 바쁘고 주말엔 조용히 쉽니다." },
  { id: "jaeh", name: "재희", gender: "MALE", age: 27, region: "BUSAN_HAEUNDAE", height: 176, job: "OFFICE_WORKER", mbti: "ESFJ", animal: "강아지상", intro: "부산 살아요. 서핑 배우는 중입니다." },
  { id: "minjun", name: "민준", gender: "MALE", age: 31, region: "SEOUL_GANGNAM", height: 179, job: "FREELANCER", mbti: "ENTP", animal: "여우상", intro: "사진 찍습니다. 같이 출사 다니실 분." },
  { id: "woojin", name: "우진", gender: "MALE", age: 25, region: "SEOUL_MAPO", height: 172, job: "STUDENT", mbti: "ISFP", animal: "토끼상", intro: "그림 그리고 전시 보러 다녀요." },
];

const REGION_SCOPE = ["SEOUL_MAPO", "SEOUL_JONGNO", "SEOUL_GANGNAM", "SEOUL_YONGSAN", "SEOUL_SEODAEMUN", "BUSAN_HAEUNDAE"];

/**
 * 사람마다 다른 아바타. 사람 사진이 아니라 색이 다른 도형이다.
 * 흐림본은 같은 그림을 뭉갠 것이라, 수락 전후 차이가 한눈에 보인다.
 */
const avatar = (index, blur) => {
  const hue = (index * 37 + 15) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue} 62% 82%)"/>`
    + `<stop offset="1" stop-color="hsl(${(hue + 28) % 360} 55% 68%)"/>`
    + `</linearGradient></defs>`
    + `<rect width="1024" height="1024" fill="url(#g)"/>`
    + `<circle cx="512" cy="408" r="176" fill="hsl(${hue} 42% 46%)"/>`
    + `<rect x="236" y="676" width="552" height="360" rx="176" fill="hsl(${hue} 42% 46%)"/>`
    + `</svg>`;
  const image = sharp(Buffer.from(svg));
  return (blur ? image.blur(26) : image).webp({ quality: 82 }).toBuffer();
};

const clean = async () => {
  const { count } = await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  console.log(`시연용 계정 ${count}개 삭제`);
};

const seed = async () => {
  if ((await prisma.user.count({ where: { email: { endsWith: DOMAIN } } })) > 0) {
    console.log("이미 있는 시연용 계정을 지우고 다시 만든다.");
    await clean();
  }
  if (!storageReady()) console.log("저장소 설정이 없다. 사진 없이 만든다.");

  const passwordHash = await bcrypt.hash(process.env.DEMO_PASSWORD ?? "kkagung123!", 12);
  const now = new Date();
  const ids = new Map();

  for (const [index, person] of people.entries()) {
    const email = person.id + DOMAIN;
    const user = await prisma.user.create({
      data: {
        email, passwordHash, role: person.role ?? "USER", status: "ACTIVE",
        adultVerifiedAt: now, lastActiveAt: now,
      },
    });
    ids.set(person.id, user.id);

    await prisma.userProfile.create({
      data: {
        userId: user.id,
        displayName: person.name,
        birthDate: new Date(Date.UTC(now.getUTCFullYear() - person.age, index % 12, 1 + (index % 27))),
        gender: person.gender,
        regionCode: person.region,
        heightCm: person.height,
        jobCategory: person.job,
        mbti: person.mbti,
        animalFace: person.animal,
        smokingStatus: index % 3 === 0 ? "SMOKER" : "NON_SMOKER",
        tattooStatus: index % 5 === 0 ? "YES" : "NO",
        militaryService: person.gender === "MALE" ? "COMPLETED" : "NOT_APPLICABLE",
        intro: person.intro,
        profileCompletedAt: now,
      },
    });

    await prisma.userPreference.create({
      data: {
        userId: user.id,
        preferredGender: person.gender === "MALE" ? "FEMALE" : "MALE",
        minAge: 22, maxAge: 40,
        regionScope: REGION_SCOPE,
      },
    });

    // 올린 사진 한 장. 원본은 선명하게, 공개본은 흐리게. AI 는 PENDING 이다(D-02).
    const key = (prefix, ext) => `${prefix}/${user.id}/demo-1.${ext}`;
    const originalKey = key("originals", "webp");
    const blurredKey = key("profiles/blur", "webp");
    if (storageReady()) {
      await putObject(privateBucket(), originalKey, await avatar(index, false), "image/webp");
      await putObject(publicBucket(), blurredKey, await avatar(index, true), "image/webp");
    }
    const common = { userId: user.id, slot: 1, byteSize: 40000, width: 1024, height: 1024, processedAt: now, failedReasonCode: null };
    await prisma.profileImage.createMany({
      data: [
        { ...common, imageType: "ORIGINAL_PRIVATE", objectKey: originalKey, generationStatus: "DONE" },
        { ...common, imageType: "BLURRED_PUBLIC", objectKey: blurredKey, generationStatus: "DONE" },
        { ...common, imageType: "AI_PUBLIC", objectKey: "", generationStatus: "PENDING", byteSize: 0, width: 0, height: 0, processedAt: null },
      ],
    });
  }

  // 시연 시작 시점에 받은 알림과 채팅방이 비어 있으면 보여줄 것이 없다. 미리 만들어 둔다.
  const presenter = ids.get("narae");
  const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (const who of ["jiwon", "seoyeon", "yuna"]) {
    await prisma.heart.create({ data: { senderId: ids.get(who), receiverId: presenter } });
  }

  for (const [who, message] of [["haeun", "안녕하세요! 프로필 보고 연락드려요. 전시 좋아하신다니 반가워요."], ["dain", "같은 동네네요. 커피 한 잔 어떠세요?"]]) {
    await prisma.chatRequest.create({
      data: { senderId: ids.get(who), receiverId: presenter, message, sourceType: "RECOMMENDATION", serviceDate },
    });
  }

  // 수락된 방 하나. 여기서 상대 원본 사진이 공개되는 것을 보여준다.
  const accepted = await prisma.chatRequest.create({
    data: {
      senderId: presenter, receiverId: ids.get("minseo"),
      message: "안녕하세요, 책 좋아하신다고 해서요. 이야기 나눠보고 싶어요.",
      status: "ACCEPTED", sourceType: "RECOMMENDATION", serviceDate, respondedAt: now,
    },
  });
  const room = await prisma.chatRoom.create({ data: { chatRequestId: accepted.id } });
  await prisma.chatRoomMember.createMany({
    data: [{ roomId: room.id, userId: presenter }, { roomId: room.id, userId: ids.get("minseo") }],
  });
  for (const [who, body] of [
    ["narae", "안녕하세요! 수락해 주셔서 고마워요."],
    ["minseo", "안녕하세요 :) 프로필에 성수동 적어두신 거 봤어요."],
    ["narae", "자주 가요. 요즘 괜찮은 데 한 곳 알아뒀는데 같이 가보실래요?"],
    ["minseo", "좋아요. 이번 주말은 어떠세요?"],
  ]) {
    await prisma.chatMessage.create({ data: { roomId: room.id, senderId: ids.get(who), body } });
  }

  console.log(`\n시연용 계정 ${people.length}개 생성`);
  console.log(`  발표자   ${PRESENTER}`);
  console.log(`  관리자   ${ADMIN}`);
  console.log(`  비밀번호 ${process.env.DEMO_PASSWORD ? "(DEMO_PASSWORD 로 지정한 값)" : "kkagung123!"}`);
  console.log(`\n발표자 계정에 미리 넣어 둔 것`);
  console.log(`  받은 하트 3개 · 받은 채팅 요청 2개 · 수락된 채팅방 1개(메시지 4개)`);
  console.log(`  오늘의 운세는 시연 중에 직접 연다.`);
};

if (has("--clean")) await clean();
else await seed();
await prisma.$disconnect();
