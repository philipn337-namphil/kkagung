/**
 * 오전 8시 시나리오 부하 측정.
 *
 * 사용자들이 8시에 몰려 운세를 열고 추천을 받는 상황을 재현한다.
 * 사용자마다 한 번씩: POST /daily/open → GET /recommendations/today
 *
 * 실행 방식이 두 가지다. NCP 에서는 Cloud DB 가 비공인 서브넷에 있고 계정 호스트가
 * 앱 서브넷 대역으로 묶여 있어, 작업자 PC 에서는 DB 에 붙을 수 없다. 그래서 DB 를
 * 쓰는 일과 HTTP 를 때리는 일을 나눈다.
 *
 *   # 1) 앱 서버 안에서: 당일 데이터를 비우고 토큰을 미리 발급해 파일로 뽑는다
 *   node infra/loadtest/run-load.mjs --export tokens.json --users 500 --reset
 *
 *   # 2) 작업자 PC 에서: 그 파일만 들고 LB 를 때린다 (DB·JWT_SECRET 불필요)
 *   node infra/loadtest/run-load.mjs --base http://<LB 주소> --tokens-file tokens.json --concurrency 50
 *
 * 로컬처럼 DB 와 서버가 모두 손에 닿는 환경에서는 예전처럼 한 번에 돌려도 된다.
 *
 *   node infra/loadtest/run-load.mjs --users 500 --concurrency 50 --reset
 *
 * 토큰은 미리 만들어 두고 측정에서 제외한다. 보려는 것은 인증 비용이 아니라
 * 운세·추천 생성 비용이다.
 *
 * 사용자마다 다른 X-Forwarded-For 를 보낸다. 그러지 않으면 모든 부하가 한 IP 로
 * 집계되어 속도 제한(api-ip 60초당 90회)에 걸려 측정이 성립하지 않는다.
 * NCP ALB 는 이 헤더를 덮어쓰지 않고 덧붙인다(측정으로 확인). 서버가 보는 값은
 * "<여기서 넣은 가짜 IP>, <작업자 공인 IP>" 가 된다. Express 의 trust proxy 는 서버 쪽부터
 * 신뢰 홉 수만큼 벗기므로, 운영값 TRUST_PROXY=1 에서는 작업자 실제 IP 가 잡히고 가짜 IP 는
 * 무시된다. 그러면 전부 한 바구니로 집계되어 측정이 성립하지 않는다.
 *
 * 측정 동안만 서버를 TRUST_PROXY=2 로 둔다. 운영에서는 반드시 1 이다. 2 로 두면
 * 클라이언트가 헤더를 한 겹 위조해 속도 제한을 우회할 수 있다.
 */
import { readFileSync, writeFileSync } from "node:fs";

// 저장소에서 바로 돌릴 때는 backend/node_modules 를, 앱 이미지 안에서 돌릴 때는
// 그 옆의 node_modules 를 쓴다. 같은 스크립트를 두 곳에서 쓰기 위해서다.
const dep = async (name, entry) => {
  try { return await import(name); }
  catch { return await import(new URL(`../../backend/node_modules/${name}/${entry}`, import.meta.url).href); }
};

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const has = (name) => process.argv.includes(name);

const BASE = arg("--base", "http://localhost:8080") + "/api/v1";
const USERS = Number(arg("--users", "500"));
const CONCURRENCY = Number(arg("--concurrency", "50"));
const TOKENS_FILE = arg("--tokens-file", null);
const EXPORT_FILE = arg("--export", null);

/** 운영 DB 를 상대로 지우지 않는다. seed-load.mjs 와 같은 기준을 쓴다. */
const assertDisposableDatabase = () => {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error("운영 환경 설정으로는 실행하지 않는다. NODE_ENV·APP_ENV 를 확인할 것.");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없다.");
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && process.env.ALLOW_REMOTE_LOAD_SEED !== "true") {
    throw new Error(`원격 호스트(${host})에는 쓰지 않는다. 필요하면 ALLOW_REMOTE_LOAD_SEED=true 로 실행할 것.`);
  }
};

/** DB 에서 부하용 계정을 읽어 토큰까지 발급한다. 앱 서버 쪽에서만 돈다. */
const buildTokens = async () => {
  assertDisposableDatabase();
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET 이 필요하다. 서버와 같은 값을 줄 것.");
  const issuer = process.env.AUTH_JWT_ISSUER ?? "kkagung-api";
  const audience = process.env.AUTH_JWT_AUDIENCE ?? "kkagung-client";

  const { PrismaClient } = await dep("@prisma/client", "index.js");
  const jwt = (await dep("jsonwebtoken", "index.js")).default;
  const prisma = new PrismaClient();

  const users = await prisma.user.findMany({
    where: { email: { endsWith: "@kkagung.load" } },
    select: { id: true },
    take: USERS,
  });

  // 그날 운세를 이미 연 사용자는 저장된 결과를 그대로 받아 빠르다. 8시에 몰리는 상황은
  // "그날 첫 열람"이므로, 되풀이 측정하려면 부하용 계정의 당일 데이터를 먼저 비운다.
  if (has("--reset")) {
    const ids = users.map((user) => user.id);
    const removed = await prisma.$transaction([
      prisma.recommendationItem.deleteMany({ where: { viewerId: { in: ids } } }),
      prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }),
      prisma.dailyFortune.deleteMany({ where: { userId: { in: ids } } }),
    ]);
    console.log(`초기화: 추천 ${removed[0].count} · 새로고침권 ${removed[1].count} · 운세 ${removed[2].count} 건 삭제`);

    // 선착순 재고는 사용자 행과 별개로 남는다. 티켓만 지우면 두 번째 실행부터 재고가
    // 바닥난 채로 시작해 "설정한 개수만 발급됐는가" 를 확인할 수 없다.
    // 남은 티켓 수로 다시 세어 맞춘다. 지우지 않은 사용자의 티켓도 그대로 반영된다.
    const inventories = await prisma.dailyRefreshInventory.findMany({ select: { serviceDate: true, totalCount: true } });
    for (const inventory of inventories) {
      const granted = await prisma.refreshToken.count({ where: { tokenDate: inventory.serviceDate } });
      await prisma.dailyRefreshInventory.update({
        where: { serviceDate: inventory.serviceDate },
        data: { grantedCount: granted, remainingCount: Math.max(0, inventory.totalCount - granted) },
      });
    }
    if (inventories.length > 0) console.log(`새로고침권 재고 ${inventories.length}일치를 남은 티켓 수에 맞춰 되돌렸다.`);
  }

  await prisma.$disconnect();
  if (users.length === 0) throw new Error("부하용 계정이 없다. seed-load.mjs 를 먼저 실행할 것.");
  if (users.length < USERS) console.log(`요청 ${USERS}명 중 ${users.length}명만 있어 그만큼만 돌린다.`);

  return users.map((user) => ({
    id: user.id.toString(),
    token: jwt.sign({ role: "USER" }, secret, {
      subject: user.id.toString(), expiresIn: "1h", issuer, audience, jwtid: crypto.randomUUID(),
    }),
  }));
};

let targets;
if (TOKENS_FILE) {
  const file = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
  targets = file.users ?? file;
  console.log(`${TOKENS_FILE} 에서 ${targets.length}명을 읽었다. 발급 ${file.issuedAt ?? "(시각 없음)"}`);
} else {
  targets = await buildTokens();
}

if (EXPORT_FILE) {
  // 토큰이 들어 있는 파일이다. 수명은 1시간이고 저장소에 커밋하지 않는다.
  writeFileSync(EXPORT_FILE, JSON.stringify({ issuedAt: new Date().toISOString(), users: targets }, null, 1));
  console.log(`${EXPORT_FILE} 에 ${targets.length}명분 토큰을 썼다. 1시간 안에 쓰고 지울 것.`);
  process.exit(0);
}

const samples = [];
const statusCount = new Map();
const record = (label, status, ms) => {
  samples.push({ label, status, ms });
  const key = `${label} ${status}`;
  statusCount.set(key, (statusCount.get(key) ?? 0) + 1);
};

const timed = async (label, url, options) => {
  const started = performance.now();
  try {
    const response = await fetch(url, options);
    await response.arrayBuffer();
    record(label, response.status, performance.now() - started);
    return response.status;
  } catch {
    record(label, "ERR", performance.now() - started);
    return "ERR";
  }
};

// 사용자마다 다른 주소로 보이게 한다. 10.x 대역을 순서대로 배정한다.
const addressFor = (index) => `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

const scenario = async (target, index) => {
  const headers = { Authorization: `Bearer ${target.token}`, "X-Forwarded-For": addressFor(index) };
  await timed("daily/open", `${BASE}/daily/open`, { method: "POST", headers });
  await timed("recommendations", `${BASE}/recommendations/today`, { headers });
};

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

console.log(`${BASE} 로 사용자 ${targets.length}명, 동시 실행 ${CONCURRENCY}개로 시작한다.`);
const startedAt = performance.now();

let cursor = 0;
const worker = async () => {
  while (true) {
    const index = cursor++;
    if (index >= targets.length) return;
    await scenario(targets[index], index);
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const elapsed = (performance.now() - startedAt) / 1000;
console.log(`\n총 ${elapsed.toFixed(1)}초, 요청 ${samples.length}건, 초당 ${(samples.length / elapsed).toFixed(0)}건\n`);

for (const label of ["daily/open", "recommendations"]) {
  const group = samples.filter((s) => s.label === label);
  const ok = group.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms);
  console.log(`${label}`);
  console.log(`  성공 ${ok.length} / ${group.length}`);
  if (ok.length > 0) {
    console.log(`  p50 ${percentile(ok, 50).toFixed(0)}ms · p95 ${percentile(ok, 95).toFixed(0)}ms · p99 ${percentile(ok, 99).toFixed(0)}ms · 최대 ${Math.max(...ok).toFixed(0)}ms`);
  }
}

console.log("\n응답 코드");
for (const [key, count] of [...statusCount.entries()].sort()) console.log(`  ${key}: ${count}`);
if ([...statusCount.keys()].some((key) => key.endsWith("429"))) {
  console.log("\n429 가 섞였다. 측정이 성립하지 않는다.");
  console.log("LB 뒤에서 잴 때는 서버를 TRUST_PROXY=2 로 두어야 한다. 1 이면 작업자 실제 IP 로");
  console.log("전부 집계된다. 측정이 끝나면 운영값 1 로 되돌릴 것.");
}
