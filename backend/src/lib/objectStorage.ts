import "dotenv/config";

/**
 * 공개 버킷의 기준 주소. 버킷명은 코드에 두지 않고 환경변수로만 읽는다(D-01).
 * 설정이 비어 있어도 서버는 떠야 하므로 import 시점이 아니라 호출 시점에 읽는다.
 */
export const publicObjectBaseUrl = () => {
  const endpoint = (process.env.OBJECT_STORAGE_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  if (endpoint === "") return null;
  // 버킷을 경로가 아닌 호스트명으로 쓰는 환경도 있어, 버킷이 비면 기준 주소를 그대로 쓴다.
  const bucket = (process.env.OBJECT_STORAGE_BUCKET_PUBLIC ?? "").trim().replace(/^\/+|\/+$/g, "");
  return bucket === "" ? endpoint : `${endpoint}/${bucket}`;
};

/**
 * 공개 버킷 객체의 읽기 URL. 기준 주소가 설정되지 않은 환경에서는 만들 수 없으므로 null 이다.
 * 비공개 버킷(원본) 객체에는 쓰지 않는다. 원본은 수락 후 서명 URL 로만 발급한다(D-01).
 */
export const publicObjectUrl = (objectKey: string) => {
  const base = publicObjectBaseUrl();
  const key = objectKey.trim().replace(/^\/+/, "");
  if (base === null || key === "") return null;
  return `${base}/${key}`;
};
