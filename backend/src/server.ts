import { app } from "./app.js";
import { config } from "./config.js";
import { publicObjectBaseUrl } from "./lib/objectStorage.js";

// 기준 주소가 비면 추천 카드의 사진이 모두 null 로 나간다. 조용히 넘어가지 않게 기동 때 알린다.
if (publicObjectBaseUrl() === null) {
  console.warn("OBJECT_STORAGE_ENDPOINT is not set: recommendation cards will be served without image URLs.");
}

app.listen(config.port, () => console.log(`kkagung API listening on :${config.port}`));
