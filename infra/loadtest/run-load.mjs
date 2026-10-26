/**
 * 오전 8시 시나리오 부하 측정.
 *
 * 사용자들이 8시에 몰려 운세를 열고 추천을 받는 상황을 재현한다.
 * 사용자마다 한 번씩: POST /daily/open → GET /recommendations/today
 *
 *   node infra/loadtest/run-load.mjs --users 500 --concurrency 50
 *
 * 토큰은 미리 만들어 두고 측정에서 제외한다. 보려는 것은 인증 비용이 아니라
 * 운세·추천 생성 비용이다.
 *
 * 사용자마다 다른 X-Forwarded-For 를 보낸다. 그러지 않으면 모든 부하가 한 IP 로
 * 집계되어 속도 제한(api-ip 60초당 90회)에 걸려 측정이 성립하지 않는다.
 * 서버에 TRUST_PROXY 가 설정돼 있어야 이 헤더가 반영된다.
 */
import jwt from "../../backend/node_modules/jsonwebtoken/index.js";
import { PrismaClient } from "../../backend/node_modules/@prisma/client/index.js";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const BASE = arg("--base", "http://localhost:8080") + "/api/v1";
const USERS = Number(arg("--users", "500"));
const CONCURRENCY = Number(arg("--concurrency", "50"));

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET 이 필요하다. 서버와 같은 값을 줄 것.");
const issuer = process.env.AUTH_JWT_ISSUER ?? "kkagung-api";
const audience = process.env.AUTH_JWT_AUDIENCE ?? "kkagung-client";

const prisma = new PrismaClient();
const users = await prisma.user.findMany({
  where: { email: { endsWith: "@kkagung.load" } },
  select: { id: true },
  take: USERS,
});

// 그날 운세를 이미 연 사용자는 저장된 결과를 그대로 받아 빠르다. 8시에 몰리는 상황은
// "그날 첫 열람"이므로, 되풀이 측정하려면 부하용 계정의 당일 데이터를 먼저 비운다.
if (process.argv.includes("--reset")) {
  const ids = users.map((user) => user.id);
  const removed = await prisma.$transaction([
    prisma.recommendationItem.deleteMany({ where: { viewerId: { in: ids } } }),
    prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }),
    prisma.dailyFortune.deleteMany({ where: { userId: { in: ids } } }),
  ]);
  console.log(`초기화: 추천 ${removed[0].count} · 새로고침권 ${removed[1].count} · 운세 ${removed[2].count} 건 삭제`);
}
await prisma.$disconnect();
if (users.length === 0) throw new Error("부하용 계정이 없다. seed-load.mjs 를 먼저 실행할 것.");
if (users.length < USERS) console.log(`요청 ${USERS}명 중 ${users.length}명만 있어 그만큼만 돌린다.`);

const tokenFor = (id) => jwt.sign({ role: "USER" }, secret, {
  subject: id.toString(), expiresIn: "1h", issuer, audience, jwtid: crypto.randomUUID(),
});

// 사용자마다 다른 주소로 보이게 한다. 10.x 대역을 순서대로 배정한다.
const addressFor = (index) => `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

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
  } catch (error) {
    record(label, "ERR", performance.now() - started);
    return "ERR";
  }
};

const scenario = async (user, index) => {
  const headers = { Authorization: `Bearer ${tokenFor(user.id)}`, "X-Forwarded-For": addressFor(index) };
  await timed("daily/open", `${BASE}/daily/open`, { method: "POST", headers });
  await timed("recommendations", `${BASE}/recommendations/today`, { headers });
};

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

console.log(`사용자 ${users.length}명, 동시 실행 ${CONCURRENCY}개로 시작한다.`);
const startedAt = performance.now();

let cursor = 0;
const worker = async () => {
  while (true) {
    const index = cursor++;
    if (index >= users.length) return;
    await scenario(users[index], index);
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
