import { randomUUID } from "node:crypto";
import sharp from "sharp";

// 명세서 4절의 제약이다. 클라이언트가 보낸 확장자·MIME 는 믿지 않고 실제 내용으로 판정한다.
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 20_000_000;
export const MAX_IMAGES_PER_USER = 3;
const ALLOWED = new Set(["jpeg", "png", "webp"]);

export type ImageRejection =
  | { code: "IMAGE_TOO_LARGE"; status: 413; message: string }
  | { code: "UNSUPPORTED_IMAGE_TYPE"; status: 415; message: string }
  | { code: "VALIDATION_ERROR"; status: 400; message: string };

export type PreparedImage = {
  original: { body: Buffer; contentType: string; width: number; height: number; byteSize: number };
  blurred: { body: Buffer; contentType: string; width: number; height: number; byteSize: number };
};

/** 저장 경로는 서버가 정한다. 사용자가 보낸 파일명은 경로에 쓰지 않는다. */
export const objectKeyFor = (kind: "original" | "blurred", userId: bigint, extension: string) =>
  `${kind === "original" ? "originals" : "profiles/blur"}/${userId.toString()}/${randomUUID()}.${extension}`;

/**
 * 업로드된 바이트를 검사하고 공개용 흐림 이미지를 만든다.
 *
 * - 형식은 sharp 가 실제로 읽어낸 값으로 판정한다. `.jpg` 이름의 텍스트나 MIME 위조는 여기서 걸린다.
 * - 원본도 다시 인코딩해 저장한다. 위치 정보를 비롯한 메타데이터를 남기지 않기 위해서다.
 * - 흐림 이미지는 신원을 가리는 용도라 크기를 줄이고 강하게 흐린다.
 */
export const prepareImage = async (input: Buffer): Promise<PreparedImage | ImageRejection> => {
  if (input.byteLength === 0) return { code: "VALIDATION_ERROR", status: 400, message: "빈 파일입니다." };
  if (input.byteLength > MAX_BYTES) {
    return { code: "IMAGE_TOO_LARGE", status: 413, message: "사진은 10MB 이하만 올릴 수 있습니다." };
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return { code: "UNSUPPORTED_IMAGE_TYPE", status: 415, message: "지원하지 않는 이미지 형식입니다." };
  }

  const format = meta.format ?? "";
  if (!ALLOWED.has(format)) {
    return { code: "UNSUPPORTED_IMAGE_TYPE", status: 415, message: "JPEG, PNG, WebP 만 올릴 수 있습니다." };
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    return { code: "UNSUPPORTED_IMAGE_TYPE", status: 415, message: "이미지 크기를 읽을 수 없습니다." };
  }
  if (width * height > MAX_PIXELS) {
    return { code: "IMAGE_TOO_LARGE", status: 413, message: "사진 해상도가 너무 큽니다." };
  }

  try {
    // rotate() 를 먼저 불러 EXIF 방향을 픽셀에 반영한다. 그래야 메타데이터를 지워도 방향이 유지된다.
    const base = sharp(input, { failOn: "error" }).rotate();
    const original = await base.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const blurred = await base
      .clone()
      .resize({ width: 480, height: 480, fit: "cover" })
      .blur(24)
      .webp({ quality: 70 })
      .toBuffer({ resolveWithObject: true });

    return {
      original: {
        body: original.data, contentType: "image/jpeg",
        width: original.info.width, height: original.info.height, byteSize: original.data.byteLength,
      },
      blurred: {
        body: blurred.data, contentType: "image/webp",
        width: blurred.info.width, height: blurred.info.height, byteSize: blurred.data.byteLength,
      },
    };
  } catch {
    return { code: "UNSUPPORTED_IMAGE_TYPE", status: 415, message: "이미지를 처리할 수 없습니다." };
  }
};
