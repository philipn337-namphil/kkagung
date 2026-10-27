import { describe, expect, it, vi } from "vitest";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { privateBucket, publicBucket, putObject } from "../src/lib/objectStorage.js";

/**
 * NCP 에서 버킷의 "공개"는 목록 공개일 뿐이고 객체 기본값은 private 이다. 브라우저가 흐림본을
 * 직접 받으려면 올릴 때 public-read 를 보내야 하고, 원본에는 절대 붙으면 안 된다(D-01).
 * 로컬·CI 저장소는 ACL 을 구현하지 않아 실제 공개 여부는 NCP 에서만 확인된다.
 * 여기서는 버킷에 따라 올바른 권한이 SDK 까지 닿는지를 본다.
 */
describe("putObject 의 공개 권한", () => {
  const aclFor = async (bucket: string) => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    try {
      await putObject(bucket, "k", Buffer.from(""), "image/webp");
      const [command] = send.mock.calls.at(-1) as [PutObjectCommand];
      return command.input.ACL;
    } finally {
      send.mockRestore();
    }
  };

  it("공개 버킷의 객체는 public-read 로 올린다", async () => {
    expect(await aclFor(publicBucket())).toBe("public-read");
  });

  it("원본 버킷의 객체에는 공개 권한을 붙이지 않는다", async () => {
    expect(await aclFor(privateBucket())).toBeUndefined();
  });

  it("버킷 설정이 비었을 때 공개로 흘러가지 않는다", async () => {
    expect(await aclFor("")).toBeUndefined();
  });
});
