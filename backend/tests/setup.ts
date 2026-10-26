import { afterAll, beforeAll } from "vitest";

// 속도 제한 카운터는 모든 인스턴스가 공유하도록 DB 에 저장된다.
// 테스트는 서비스 날짜를 고정하려고 가짜 시각을 쓰므로 윈도 시작 시각도 항상 같은 값이 되고,
// 그 한 행에 호출 수가 계속 누적된다. 정리하지 않으면 테스트를 두세 번 돌리는 것만으로
// api-ip 한도(60초당 90회)를 넘겨 관계없는 테스트가 429 로 깨진다.
//
// 다만 이 정리는 테이블 전체를 지운다. DATABASE_URL 이 공유 DB 를 가리키면 운영 중인
// 제한 상태까지 지워지므로, 지우기 전에 대상이 버려도 되는 DB 인지 먼저 확인한다.
// (보안 검토 INTEGRATION_REVIEW_20261025 / LIVE_DB_REVIEW_20261026 지적 사항)

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const OPT_IN = "ALLOW_SHARED_DB_TEST_CLEANUP";

const assertDisposableDatabase = () => {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production") {
    throw new Error("운영 환경 설정으로는 테스트를 실행하지 않는다. NODE_ENV·APP_ENV 를 확인할 것.");
  }
  if (process.env[OPT_IN] === "true") return;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 없다. 테스트용 DB 를 지정할 것.");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL 을 해석할 수 없다. 테스트용 DB 를 지정할 것.");
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `테스트는 속도 제한 카운터 테이블을 비운다. 원격 호스트(${host})를 대상으로는 실행하지 않는다. ` +
        `버려도 되는 DB 임이 확실하면 ${OPT_IN}=true 로 실행할 것.`,
    );
  }
};

const clearRateLimitCounters = async () => {
  assertDisposableDatabase();
  const { prisma } = await import("../src/prisma.js");
  await prisma.rateLimitCounter.deleteMany({});
  await prisma.$disconnect();
};

beforeAll(clearRateLimitCounters);
afterAll(clearRateLimitCounters);
