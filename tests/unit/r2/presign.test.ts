// tests/unit/r2/presign.test.ts
//
// Spec for lib/r2/presign.ts. Verifies that each helper:
//   - signs the RIGHT Command class with the RIGHT input shape
//     (Bucket/Key + multipart fields where relevant)
//   - forwards `ttl` as the AWS-SDK `expiresIn` option
//   - conditionally includes ContentType only when the caller supplied it
//   - fails fast (TypeError) on empty strings and non-positive integers,
//     and BEFORE calling getSignedUrl — so bad input never wastes a
//     signing roundtrip and never leaks into the signed URL
//   - routes upstream presign failures through mapR2Error, so the route
//     layer sees the same R2CredentialError / R2UpstreamError split as
//     real R2 calls in lib/r2/control.ts
//
// Mocking strategy:
//   Only @aws-sdk/s3-request-presigner is mocked. The real *Command
//   classes from @aws-sdk/client-s3 are kept so we can inspect each
//   command's `.input` and confirm the signed payload — that's the
//   field the SDK actually serializes, and asserting on it catches
//   field-name typos (Bucket vs bucket, PartNumber vs partNumber).

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

import {
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  presignGet,
  presignPut,
  presignUploadPart,
} from "@/lib/r2/presign";

// The helpers only forward the client into getSignedUrl — they never
// read off it — so an empty object is enough. Casting documents that
// the test never relies on real S3Client behavior.
const client = {} as S3Client;

const SIGNED_URL = "https://signed.example/abc?X-Amz-Signature=deadbeef";

beforeEach(() => {
  vi.mocked(getSignedUrl).mockReset();
  vi.mocked(getSignedUrl).mockResolvedValue(SIGNED_URL);
});

function lastSignedCall(): {
  client: unknown;
  command: unknown;
  options: unknown;
} {
  const calls = vi.mocked(getSignedUrl).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("getSignedUrl was not called");
  return { client: last[0], command: last[1], options: last[2] };
}

describe("presignPut: signing payload", () => {
  const base = {
    client,
    bucket: "my-bucket",
    key: "path/to/file.txt",
    ttl: 300,
  };

  it("returns the URL produced by getSignedUrl", async () => {
    await expect(presignPut(base)).resolves.toBe(SIGNED_URL);
  });

  it("signs a PutObjectCommand and forwards ttl as expiresIn", async () => {
    await presignPut(base);
    const call = lastSignedCall();
    expect(call.client).toBe(client);
    expect(call.command).toBeInstanceOf(PutObjectCommand);
    expect((call.command as PutObjectCommand).input).toMatchObject({
      Bucket: "my-bucket",
      Key: "path/to/file.txt",
    });
    expect(call.options).toEqual({ expiresIn: 300 });
  });

  it("includes ContentType on the command when the caller supplied one", async () => {
    await presignPut({ ...base, contentType: "image/png" });
    const cmd = lastSignedCall().command as PutObjectCommand;
    expect(cmd.input.ContentType).toBe("image/png");
  });

  it("omits ContentType entirely when not supplied (vs setting undefined)", async () => {
    await presignPut(base);
    const cmd = lastSignedCall().command as PutObjectCommand;
    expect("ContentType" in cmd.input).toBe(false);
  });
});

describe("presignPut: input validation", () => {
  const base = {
    client,
    bucket: "b",
    key: "k",
    ttl: 300,
  };

  it.each([
    ["bucket", { ...base, bucket: "" }],
    ["key", { ...base, key: "" }],
  ])(
    "throws TypeError when %s is empty, before calling getSignedUrl",
    async (_field, params) => {
      await expect(presignPut(params)).rejects.toBeInstanceOf(TypeError);
      expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
  ])("throws TypeError when ttl is %s", async (_label, ttl) => {
    await expect(presignPut({ ...base, ttl })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
  });

  it("error message names the offending field (debuggability)", async () => {
    await expect(presignPut({ ...base, bucket: "" })).rejects.toThrow(
      /bucket/,
    );
  });
});

describe("presignGet: signing payload", () => {
  const base = {
    client,
    bucket: "my-bucket",
    key: "downloads/x.bin",
    ttl: 900,
  };

  it("signs a GetObjectCommand and forwards ttl as expiresIn", async () => {
    await presignGet(base);
    const call = lastSignedCall();
    expect(call.command).toBeInstanceOf(GetObjectCommand);
    expect((call.command as GetObjectCommand).input).toMatchObject({
      Bucket: "my-bucket",
      Key: "downloads/x.bin",
    });
    expect(call.options).toEqual({ expiresIn: 900 });
  });

  it("returns the URL produced by getSignedUrl", async () => {
    await expect(presignGet(base)).resolves.toBe(SIGNED_URL);
  });
});

describe("presignGet: input validation", () => {
  const base = { client, bucket: "b", key: "k", ttl: 900 };

  it.each([
    ["bucket", { ...base, bucket: "" }],
    ["key", { ...base, key: "" }],
  ])("throws TypeError when %s is empty", async (_field, params) => {
    await expect(presignGet(params)).rejects.toBeInstanceOf(TypeError);
    expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
  });

  it("throws when ttl is non-positive", async () => {
    await expect(presignGet({ ...base, ttl: 0 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe("presignUploadPart: signing payload", () => {
  const base = {
    client,
    bucket: "my-bucket",
    key: "big-file.bin",
    uploadId: "upload-abc-123",
    partNumber: 1,
    ttl: 300,
  };

  it("signs an UploadPartCommand with full multipart fields", async () => {
    await presignUploadPart(base);
    const call = lastSignedCall();
    expect(call.command).toBeInstanceOf(UploadPartCommand);
    expect((call.command as UploadPartCommand).input).toMatchObject({
      Bucket: "my-bucket",
      Key: "big-file.bin",
      UploadId: "upload-abc-123",
      PartNumber: 1,
    });
    expect(call.options).toEqual({ expiresIn: 300 });
  });

  it("returns the URL produced by getSignedUrl", async () => {
    await expect(presignUploadPart(base)).resolves.toBe(SIGNED_URL);
  });
});

describe("presignUploadPart: input validation", () => {
  const base = {
    client,
    bucket: "b",
    key: "k",
    uploadId: "u",
    partNumber: 1,
    ttl: 300,
  };

  it.each([
    ["bucket", { ...base, bucket: "" }],
    ["key", { ...base, key: "" }],
    ["uploadId", { ...base, uploadId: "" }],
  ])("throws TypeError when %s is empty", async (_field, params) => {
    await expect(presignUploadPart(params)).rejects.toBeInstanceOf(TypeError);
    expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
  ])(
    "throws TypeError when partNumber is %s (S3 parts are 1-based ints)",
    async (_label, partNumber) => {
      await expect(
        presignUploadPart({ ...base, partNumber }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
    },
  );

  it("throws when ttl is non-positive", async () => {
    await expect(
      presignUploadPart({ ...base, ttl: 0 }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("presign helpers: upstream error mapping", () => {
  it("PUT presign credential failure → R2CredentialError", async () => {
    vi.mocked(getSignedUrl).mockRejectedValueOnce(
      Object.assign(new Error("upstream"), { name: "InvalidAccessKeyId" }),
    );
    await expect(
      presignPut({ client, bucket: "b", key: "k", ttl: 60 }),
    ).rejects.toMatchObject({ name: "R2CredentialError" });
  });

  it("GET presign SignatureDoesNotMatch → R2CredentialError", async () => {
    vi.mocked(getSignedUrl).mockRejectedValueOnce(
      Object.assign(new Error("bad sig"), { name: "SignatureDoesNotMatch" }),
    );
    await expect(
      presignGet({ client, bucket: "b", key: "k", ttl: 60 }),
    ).rejects.toMatchObject({ name: "R2CredentialError" });
  });

  it("UploadPart presign generic SDK error → R2UpstreamError with code+httpStatus", async () => {
    vi.mocked(getSignedUrl).mockRejectedValueOnce(
      Object.assign(new Error("nope"), {
        name: "InternalError",
        $metadata: { httpStatusCode: 500 },
      }),
    );
    await expect(
      presignUploadPart({
        client,
        bucket: "b",
        key: "k",
        uploadId: "u",
        partNumber: 1,
        ttl: 60,
      }),
    ).rejects.toMatchObject({
      name: "R2UpstreamError",
      code: "InternalError",
      httpStatus: 500,
    });
  });
});
