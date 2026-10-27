import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import sharp from "sharp";

// 사진 업로드는 실제 객체 저장소가 있어야 의미가 있다. 저장소 설정이 없으면 테스트를 세워
// 통과한 것처럼 보이지 않게 한다. 로컬·CI 모두 S3 호환 저장소를 띄운 뒤 실행한다.
//
// 시드 계정은 쓰지 않는다. 사진을 지우고 올리는 테스트라 시드 이미지를 건드리면
// 추천 테스트처럼 시드 상태를 세는 다른 파일이 깨진다. 전용 계정을 만들고 끝나면 지운다.
const OWNER = "image-owner@kkagung.test";
const STRANGER = "image-stranger@kkagung.test";
const EMAILS = [OWNER, STRANGER];

let server: Server | null = null;
let baseUrl = "";
let db: Awaited<ReturnType<typeof loadPrisma>>;
let jwtSecret = "";
let jwtIssuer = "";
let jwtAudience = "";
let ids: Record<string, bigint> = {};

const loadPrisma = async () => (await import("../src/prisma.js")).prisma;
const tokenFor = (userId: bigint) => jwt.sign({ role: "USER" }, jwtSecret, {
  subject: userId.toString(), expiresIn: "12h", issuer: jwtIssuer, audience: jwtAudience, jwtid: crypto.randomUUID(),
});

const call = async (path: string, options: { method?: string; token?: string; body?: BodyInit } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers, body: options.body });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text), headers: response.headers };
};

const photo = async (width = 1200, height = 900) =>
  sharp({ create: { width, height, channels: 3, background: "#c96" } }).jpeg().toBuffer();

const upload = async (email: string, buffer: Buffer, filename = "me.jpg", type = "image/jpeg") => {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), filename);
  return call("/api/v1/me/images", { method: "POST", token: tokenFor(ids[email]), body: form });
};

/** 전용 계정의 사진만 지운다. 시드 계정 데이터는 건드리지 않는다. */
const clearOwnImages = async () => {
  await db.profileImage.deleteMany({ where: { userId: { in: Object.values(ids) } } });
};

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  const appConfig = (await import("../src/config.js")).config;
  jwtSecret = appConfig.jwtSecret; jwtIssuer = appConfig.jwtIssuer; jwtAudience = appConfig.jwtAudience;
  const storage = await import("../src/lib/objectStorage.js");
  if (!storage.storageReady()) {
    throw new Error("OBJECT_STORAGE_* 설정이 없다. S3 호환 저장소를 띄운 뒤 실행할 것.");
  }
  await storage.ensureBuckets();

  db = await loadPrisma();
  // 전용 계정을 만들어 쓴다. 비밀번호 해시는 로그인에 쓰지 않으므로 자리표시자면 충분하다.
  for (const email of EMAILS) {
    await db.user.upsert({
      where: { email },
      update: { status: "ACTIVE", adultVerifiedAt: new Date() },
      create: { email, passwordHash: "test-only-no-login", adultVerifiedAt: new Date() },
    });
  }
  const users = await db.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true, email: true } });
  ids = Object.fromEntries(users.map((user) => [user.email, user.id]));
  expect(Object.keys(ids)).toHaveLength(EMAILS.length);

  baseUrl = await new Promise<string>((resolve, reject) => {
    const started = app.listen(0, () => {
      const address = started.address();
      if (address === null || typeof address === "string") return reject(new Error("포트를 확인할 수 없습니다."));
      resolve(`http://127.0.0.1:${address.port}`);
    });
    started.on("error", reject);
    server = started;
  });
});

beforeEach(clearOwnImages);

afterAll(async () => {
  await clearOwnImages();
  // 전용 계정까지 지워 DB 를 원래 상태로 돌려놓는다.
  await db.user.deleteMany({ where: { email: { in: EMAILS } } });
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await db.$disconnect();
});

describe("POST /api/v1/me/images", () => {
  it("원본과 흐림본을 저장하고 AI 는 처리 대기로 남긴다", async () => {
    const response = await upload(OWNER, await photo());

    expect(response.status).toBe(202);
    expect(response.body.data.slot).toBe(1);
    // D-02: 공급자가 정해지기 전까지 AI 변환은 PENDING 으로 둔다.
    expect(response.body.data.generationStatus).toBe("PENDING");

    const rows = await db.profileImage.findMany({ where: { userId: ids[OWNER] } });
    expect(rows.map((row) => row.imageType).sort()).toEqual(["AI_PUBLIC", "BLURRED_PUBLIC", "ORIGINAL_PRIVATE"]);
    expect(rows.find((row) => row.imageType === "AI_PUBLIC")!.generationStatus).toBe("PENDING");
    expect(rows.find((row) => row.imageType === "BLURRED_PUBLIC")!.generationStatus).toBe("DONE");
  });

  it("빈 자리를 찾아 차례로 채우고 네 번째는 409 로 거절한다", async () => {
    const image = await photo();
    for (const slot of [1, 2, 3]) {
      const response = await upload(OWNER, image);
      expect(response.status).toBe(202);
      expect(response.body.data.slot).toBe(slot);
    }
    const fourth = await upload(OWNER, image);
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("IMAGE_LIMIT_EXCEEDED");
  });

  it("이름만 이미지인 파일은 415 로 거절한다", async () => {
    const response = await upload(OWNER, Buffer.from("이건 그냥 텍스트입니다"), "fake.jpg");
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("UNSUPPORTED_IMAGE_TYPE");
  });

  it("MIME 를 속여도 실제 내용으로 판정한다", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
    // 서버가 믿는 것은 선언된 타입이 아니라 바이트다. 올바른 PNG 이므로 통과해야 한다.
    const response = await upload(OWNER, png, "photo.gif", "image/gif");
    expect(response.status).toBe(202);
  });

  it("빈 파일은 400 으로 거절한다", async () => {
    const response = await upload(OWNER, Buffer.alloc(0));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("용량을 넘기면 413 으로 거절한다", async () => {
    const big = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "#123" } })
      .png({ compressionLevel: 0 }).toBuffer();
    const response = await upload(OWNER, big, "big.png", "image/png");
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("IMAGE_TOO_LARGE");
  });

  it("로그인하지 않으면 401 이다", async () => {
    const form = new FormData();
    form.append("file", new Blob([await photo()], { type: "image/jpeg" }), "me.jpg");
    const response = await call("/api/v1/me/images", { method: "POST", body: form });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/me/images", () => {
  it("원본은 짧은 서명 URL 로만 주고 object key 는 응답에 넣지 않는다", async () => {
    await upload(OWNER, await photo());
    const response = await call("/api/v1/me/images", { token: tokenFor(ids[OWNER]) });

    expect(response.status).toBe(200);
    const image = response.body.data.images[0];
    expect(image.originalUrl).toContain("X-Amz-Signature");
    expect(image.publicType).toBe("BLURRED_PUBLIC");
    expect(response.text).not.toContain("objectKey");
    // 원본 주소가 캐시에 남으면 만료 정책이 무의미해진다.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("서명 없이 원본 주소에 접근하면 저장소가 거부한다", async () => {
    await upload(OWNER, await photo());
    const image = (await call("/api/v1/me/images", { token: tokenFor(ids[OWNER]) })).body.data.images[0];

    const signed = await fetch(image.originalUrl);
    expect(signed.status).toBe(200);

    const unsigned = await fetch(String(image.originalUrl).split("?")[0]);
    expect(unsigned.status).toBe(403);
  });

  it("흐림본은 익명으로 받을 수 있다", async () => {
    await upload(OWNER, await photo());
    const image = (await call("/api/v1/me/images", { token: tokenFor(ids[OWNER]) })).body.data.images[0];
    const response = await fetch(image.publicUrl);
    expect(response.status).toBe(200);
  });

  it("다른 사람의 사진은 보이지 않는다", async () => {
    await upload(OWNER, await photo());
    const response = await call("/api/v1/me/images", { token: tokenFor(ids[STRANGER]) });
    expect(response.body.data.images).toHaveLength(0);
  });
});

describe("GET /api/v1/me/images/status", () => {
  it("공개 버전의 처리 상태만 돌려준다", async () => {
    await upload(OWNER, await photo());
    const response = await call("/api/v1/me/images/status", { token: tokenFor(ids[OWNER]) });

    expect(response.status).toBe(200);
    const types = response.body.data.items.map((item: { type: string }) => item.type).sort();
    expect(types).toEqual(["AI_PUBLIC", "BLURRED_PUBLIC"]);
    const ai = response.body.data.items.find((item: { type: string }) => item.type === "AI_PUBLIC");
    expect(ai.status).toBe("PENDING");
    expect(ai.publicUrl).toBeNull();
  });
});

describe("DELETE /api/v1/me/images/:imageId", () => {
  it("같은 자리의 원본·흐림본·AI 를 함께 지운다", async () => {
    const created = await upload(OWNER, await photo());
    const imageId = created.body.data.imageId;
    const before = (await call("/api/v1/me/images", { token: tokenFor(ids[OWNER]) })).body.data.images[0];

    const response = await call(`/api/v1/me/images/${imageId}`, { method: "DELETE", token: tokenFor(ids[OWNER]) });
    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(true);

    expect(await db.profileImage.count({ where: { userId: ids[OWNER] } })).toBe(0);
    // 행만 지우고 객체가 남으면 주소를 아는 사람이 계속 받아갈 수 있다.
    expect((await fetch(before.publicUrl)).status).toBe(404);
  });

  it("남의 사진은 있는지 여부도 알리지 않고 404 다", async () => {
    const created = await upload(OWNER, await photo());
    const response = await call(`/api/v1/me/images/${created.body.data.imageId}`, {
      method: "DELETE", token: tokenFor(ids[STRANGER]),
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(await db.profileImage.count({ where: { userId: ids[OWNER] } })).toBe(3);
  });

  it("없는 사진은 404 다", async () => {
    const response = await call("/api/v1/me/images/99999999", { method: "DELETE", token: tokenFor(ids[OWNER]) });
    expect(response.status).toBe(404);
  });
});

describe("같은 자리 동시 업로드 (IMG-01)", () => {
  it("한쪽은 409 로 밀리고 저장소에 주인 없는 객체를 남기지 않는다", async () => {
    const storage = await import("../src/lib/objectStorage.js");
    const prefixes = [
      [storage.privateBucket(), `originals/${ids[OWNER]}/`],
      [storage.publicBucket(), `profiles/blur/${ids[OWNER]}/`],
    ] as const;
    // 앞선 테스트가 남긴 객체와 섞이지 않게, 이번 요청이 새로 만든 것만 본다.
    const before = new Set(
      (await Promise.all(prefixes.map(([bucket, prefix]) => storage.listObjects(bucket, prefix)))).flat(),
    );

    // 두 요청이 같은 빈 자리를 함께 보고 들어간다. 유니크 제약이 하나를 떨어뜨리는데,
    // 그때 이미 올린 원본·흐림본을 정리하지 않으면 DB 가 참조하지 않는 객체가 남는다.
    const image = await photo();
    const results = await Promise.all([upload(OWNER, image), upload(OWNER, image)]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("IMAGE_LIMIT_EXCEEDED");

    const rows = await db.profileImage.findMany({ where: { userId: ids[OWNER] } });
    expect(rows.filter((row) => row.imageType === "ORIGINAL_PRIVATE")).toHaveLength(1);

    const referenced = new Set(rows.map((row) => row.objectKey).filter((key) => key !== ""));
    const after = (await Promise.all(prefixes.map(([bucket, prefix]) => storage.listObjects(bucket, prefix)))).flat();
    const created = after.filter((key) => !before.has(key));
    // 살아남은 요청의 원본·흐림본 두 개만 남아야 한다.
    for (const key of created) {
      expect(referenced.has(key), `주인 없는 객체가 남았다: ${key}`).toBe(true);
    }
    expect(created).toHaveLength(2);
  });
});
