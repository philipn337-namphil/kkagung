import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 테스트 파일들이 같은 개발 데이터베이스와 같은 시드 계정을 쓴다.
    // 병렬로 돌면 서로의 행을 지워 간헐적으로 실패하므로 파일을 순서대로 실행한다.
    fileParallelism: false,
    // 파일마다 속도 제한 카운터를 비운다. 자세한 이유는 tests/setup.ts 주석 참고.
    setupFiles: ["./tests/setup.ts"],
  },
});
