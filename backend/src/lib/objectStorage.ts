import "dotenv/config";
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * 공개 버킷의 기준 주소. 버킷명은 코드에 두지 않고 환경변수로만 읽는다(D-01).
 * 설정이 비어 있어도 서버는 떠야 하므로 import 시점이 아니라 호출 시점에 읽는다.
 */
export const publicObjectBaseUrl = () => {
  // 서버가 S3 API 를 호출하는 주소(OBJECT_STORAGE_ENDPOINT)와 브라우저가 이미지를 받는 주소는
  // 다를 수 있다. 컨테이너 안에서는 서비스 이름으로 부르지만 브라우저는 그 이름을 찾지 못한다.
  // 그래서 공개 주소가 따로 설정돼 있으면 그쪽을 먼저 쓴다.
  const browserEndpoint = (process.env.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const apiEndpoint = (process.env.OBJECT_STORAGE_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const endpoint = browserEndpoint !== "" ? browserEndpoint : apiEndpoint;
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

// 아래는 실제 저장소 접근이다. NCP Object Storage 는 S3 호환이라 같은 코드로 동작하며,
// 로컬에서는 같은 프로토콜을 제공하는 컨테이너를 쓴다. 바뀌는 것은 엔드포인트와 자격증명뿐이다.

const env = (name: string) => (process.env[name] ?? "").trim();
export const publicBucket = () => env("OBJECT_STORAGE_BUCKET_PUBLIC");
export const privateBucket = () => env("OBJECT_STORAGE_BUCKET_PRIVATE");

/** 저장소 설정이 갖춰졌는지. 업로드 경로는 이 값이 false 면 503 으로 거절한다. */
export const storageReady = () =>
  env("OBJECT_STORAGE_ENDPOINT") !== "" && env("OBJECT_STORAGE_ACCESS_KEY") !== "" &&
  env("OBJECT_STORAGE_SECRET_KEY") !== "" && publicBucket() !== "" && privateBucket() !== "";

let cached: S3Client | null = null;
const client = () => {
  if (cached !== null) return cached;
  if (!storageReady()) throw new Error("Object storage is not configured.");
  cached = new S3Client({
    endpoint: env("OBJECT_STORAGE_ENDPOINT"),
    region: env("OBJECT_STORAGE_REGION") || "us-east-1",
    // 경로 방식 주소를 쓴다. 버킷을 호스트명에 넣는 방식은 로컬 컨테이너에서 동작하지 않는다.
    forcePathStyle: env("OBJECT_STORAGE_FORCE_PATH_STYLE") !== "false",
    credentials: {
      accessKeyId: env("OBJECT_STORAGE_ACCESS_KEY"),
      secretAccessKey: env("OBJECT_STORAGE_SECRET_KEY"),
    },
  });
  return cached;
};

/**
 * 객체를 올린다. 공개 권한은 호출부가 고르지 않고 버킷으로 정해진다.
 *
 * NCP 에서 버킷의 "공개"는 목록 공개일 뿐이고 객체는 기본이 private 이다. 브라우저가 흐림본을
 * 직접 받으려면 올릴 때 public-read 를 함께 보내야 한다. 빠뜨리면 공개 버킷인데도 403 이다.
 * 반대로 원본에 이 권한이 붙으면 수락 전 신원 노출을 막는 경계가 무너진다(D-01).
 *
 * 둘 다 호출부에서 실수하기 쉬운 선택이라 여기서 버킷을 보고 결정한다.
 */
export const putObject = async (bucket: string, key: string, body: Buffer, contentType: string) => {
  const isPublic = bucket !== "" && bucket === publicBucket();
  await client().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    ACL: isPublic ? "public-read" : undefined,
  }));
};

/**
 * 접두사로 객체 키를 모아 돌려준다. DB 가 참조하지 않는 객체가 남지 않았는지 확인할 때 쓴다.
 * 목록은 한 번에 다 오지 않을 수 있어 continuation token 을 따라간다.
 */
export const listObjects = async (bucket: string, prefix: string) => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
};

export const deleteObject = async (bucket: string, key: string) => {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

/**
 * 원본 객체의 임시 읽기 URL. 본인 확인을 마친 요청에만 돌려주고 수명을 짧게 둔다(D-01).
 * 이 URL 을 만들어 주는 것 외에 원본 object key 는 어떤 응답에도 넣지 않는다.
 */
let cachedSigner: S3Client | null = null;
/**
 * 서명 URL 은 브라우저가 직접 여는 주소라, 서버가 쓰는 내부 엔드포인트로 서명하면 안 된다.
 * 서명에 호스트가 포함되므로 발급 시점에 브라우저용 주소로 만들어야 한다.
 */
const signingClient = () => {
  const browserEndpoint = env("OBJECT_STORAGE_PUBLIC_ENDPOINT");
  if (browserEndpoint === "") return client();
  if (cachedSigner !== null) return cachedSigner;
  if (!storageReady()) throw new Error("Object storage is not configured.");
  cachedSigner = new S3Client({
    endpoint: browserEndpoint,
    region: env("OBJECT_STORAGE_REGION") || "us-east-1",
    forcePathStyle: env("OBJECT_STORAGE_FORCE_PATH_STYLE") !== "false",
    credentials: {
      accessKeyId: env("OBJECT_STORAGE_ACCESS_KEY"),
      secretAccessKey: env("OBJECT_STORAGE_SECRET_KEY"),
    },
  });
  return cachedSigner;
};

export const privateObjectUrl = (key: string, expiresInSeconds = 60) =>
  getSignedUrl(signingClient(), new GetObjectCommand({ Bucket: privateBucket(), Key: key }), { expiresIn: expiresInSeconds });

/**
 * 개발 환경에서만 버킷을 만들어 둔다. 운영에서는 인프라가 정책까지 포함해 미리 만들며,
 * 애플리케이션에 버킷 생성 권한을 주지 않는다.
 */
export const ensureBuckets = async () => {
  for (const bucket of [publicBucket(), privateBucket()]) {
    try {
      await client().send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
    }
  }
};
