import { afterAll, beforeAll } from "vitest";

// 속도 제한 카운터는 모든 인스턴스가 공유하도록 DB 에 저장된다.
// 테스트는 서비스 날짜를 고정하려고 가짜 시각을 쓰므로 윈도 시작 시각도 항상 같은 값이 되고,
// 그 한 행에 호출 수가 계속 누적된다. 그래서 정리하지 않으면 테스트를 두세 번 돌리는 것만으로
// api-ip 한도(60초당 90회)를 넘겨 관계없는 테스트가 429 로 깨진다.
// 카운터는 만료 시각을 가진 일회성 집계라 테스트 사이에 지워도 안전하다.
const clearRateLimitCounters = async () => {
  const { prisma } = await import("../src/prisma.js");
  await prisma.rateLimitCounter.deleteMany({});
  await prisma.$disconnect();
};

beforeAll(clearRateLimitCounters);
afterAll(clearRateLimitCounters);
