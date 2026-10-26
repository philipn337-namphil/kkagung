import { app } from "./app.js";
import { config } from "./config.js";
import { ensureBuckets, publicObjectBaseUrl, storageReady } from "./lib/objectStorage.js";

// 기준 주소가 비면 추천 카드의 사진이 모두 null 로 나간다. 조용히 넘어가지 않게 기동 때 알린다.
if (publicObjectBaseUrl() === null) {
  console.warn("OBJECT_STORAGE_ENDPOINT is not set: recommendation cards will be served without image URLs.");
}

// 개발 환경에서는 버킷이 없으면 만들어 둔다. 운영에서는 인프라가 정책까지 포함해 미리 만들고
// 애플리케이션에는 버킷 생성 권한을 주지 않으므로 시도하지 않는다.
if (!config.production && storageReady()) {
  ensureBuckets().catch((error: unknown) => {
    console.warn("object storage buckets are not ready:", (error as Error).message);
  });
}

app.listen(config.port, () => console.log(`kkagung API listening on :${config.port}`));
