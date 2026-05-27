// tests/unit/api/schemas.test.ts
//
// Spec for lib/api/schemas.ts. Focused on the shared primitives that all
// downstream route schemas will reuse — if these regress, every API input
// silently changes shape.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BucketNameSchema,
  ConfirmationTokenSchema,
  LoginSchema,
  ObjectKeySchema,
  R2MultipartAbortSchema,
  R2MultipartCompleteSchema,
  R2MultipartCreateSchema,
  R2PresignSchema,
  R2_PRESIGN_MAX_TTL_SECONDS,
  UlidSchema,
  parseJson,
} from "@/lib/api/schemas";

describe("primitive schemas", () => {
  it("UlidSchema accepts valid Crockford base32, rejects others", () => {
    expect(UlidSchema.safeParse("01HWXYZABCDEFGHJKMNPQRSTVW").success).toBe(
      true,
    );
    expect(UlidSchema.safeParse("not-a-ulid").success).toBe(false);
    expect(UlidSchema.safeParse("01hwxyzabcdefghjkmnpqrstvw").success).toBe(
      false,
    ); // lowercase
    expect(UlidSchema.safeParse("0".repeat(25)).success).toBe(false); // too short
  });

  it("BucketNameSchema follows S3 rules", () => {
    expect(BucketNameSchema.safeParse("my-bucket-1").success).toBe(true);
    expect(BucketNameSchema.safeParse("ab").success).toBe(false); // < 3
    expect(BucketNameSchema.safeParse("UPPERCASE").success).toBe(false);
    expect(BucketNameSchema.safeParse("-leading-hyphen").success).toBe(false);
    expect(BucketNameSchema.safeParse("trailing-hyphen-").success).toBe(false);
  });

  it("ObjectKeySchema rejects leading slash and oversized inputs", () => {
    expect(ObjectKeySchema.safeParse("path/to/file.txt").success).toBe(true);
    expect(ObjectKeySchema.safeParse("/abs.txt").success).toBe(false);
    expect(ObjectKeySchema.safeParse("").success).toBe(false);
    expect(ObjectKeySchema.safeParse("a".repeat(1025)).success).toBe(false);
  });

  it("ConfirmationTokenSchema requires 16–128 chars", () => {
    expect(ConfirmationTokenSchema.safeParse("a".repeat(16)).success).toBe(
      true,
    );
    expect(ConfirmationTokenSchema.safeParse("a".repeat(15)).success).toBe(
      false,
    );
    expect(ConfirmationTokenSchema.safeParse("a".repeat(129)).success).toBe(
      false,
    );
  });

  it("LoginSchema enforces email + min(8) password", () => {
    expect(
      LoginSchema.safeParse({
        email: "alice@example.com",
        password: "hunter22!",
      }).success,
    ).toBe(true);
    expect(
      LoginSchema.safeParse({ email: "bad", password: "hunter22!" }).success,
    ).toBe(false);
    expect(
      LoginSchema.safeParse({ email: "alice@example.com", password: "short" })
        .success,
    ).toBe(false);
  });
});

describe("parseJson helper", () => {
  function jsonRequest(body: string): Request {
    return new Request("https://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("parses valid JSON through the schema", async () => {
    const schema = z.object({ name: z.string() });
    const out = await parseJson(jsonRequest('{"name":"hi"}'), schema);
    expect(out).toEqual({ name: "hi" });
  });

  it("throws ZodError for invalid payload (so withApi maps to 400)", async () => {
    const schema = z.object({ n: z.number() });
    await expect(
      parseJson(jsonRequest('{"n":"oops"}'), schema),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("throws ZodError (not SyntaxError) for malformed JSON", async () => {
    const schema = z.object({ n: z.number() });
    await expect(
      parseJson(jsonRequest("not-json"), schema),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});

describe("R2PresignSchema", () => {
  const VALID_CID = "01HWXYZABCDEFGHJKMNPQRSTVW";
  const baseFields = {
    cid: VALID_CID,
    bucket: "my-bucket",
    key: "path/file.bin",
  };

  it("accepts a minimal put payload (ttl optional)", () => {
    const r = R2PresignSchema.safeParse({ ...baseFields, op: "put" });
    expect(r.success).toBe(true);
  });

  it("accepts a get payload with ttl at the upper bound (7200)", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      op: "get",
      ttl: R2_PRESIGN_MAX_TTL_SECONDS,
    });
    expect(r.success).toBe(true);
  });

  it("rejects ttl above 7200 (anti-abuse cap)", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      op: "get",
      ttl: R2_PRESIGN_MAX_TTL_SECONDS + 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects ttl <= 0 and non-integer ttl", () => {
    for (const ttl of [0, -1, 1.5]) {
      const r = R2PresignSchema.safeParse({
        ...baseFields,
        op: "put",
        ttl,
      });
      expect(r.success).toBe(false);
    }
  });

  it("accepts an upload-part payload with uploadId + partNumber", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      op: "upload-part",
      uploadId: "upload-123",
      partNumber: 1,
    });
    expect(r.success).toBe(true);
  });

  it("rejects upload-part without uploadId", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      op: "upload-part",
      partNumber: 1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects upload-part without partNumber", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      op: "upload-part",
      uploadId: "u1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects upload-part with partNumber out of S3 range", () => {
    for (const partNumber of [0, 10_001, 1.5, -1]) {
      const r = R2PresignSchema.safeParse({
        ...baseFields,
        op: "upload-part",
        uploadId: "u1",
        partNumber,
      });
      expect(r.success).toBe(false);
    }
  });

  it("rejects an unknown op (discriminator narrowing)", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      op: "delete",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-ULID cid (prevents enumeration of malformed IDs)", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      cid: "not-a-ulid",
      op: "get",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid bucket name", () => {
    const r = R2PresignSchema.safeParse({
      ...baseFields,
      bucket: "UPPERCASE-BAD",
      op: "get",
    });
    expect(r.success).toBe(false);
  });
});

describe("R2 multipart schemas", () => {
  const VALID_CID = "01HWXYZABCDEFGHJKMNPQRSTVW";
  const base = {
    cid: VALID_CID,
    bucket: "my-bucket",
    key: "big/blob.bin",
  };

  describe("R2MultipartCreateSchema", () => {
    it("accepts the minimal payload (contentType optional)", () => {
      expect(R2MultipartCreateSchema.safeParse(base).success).toBe(true);
    });

    it("accepts an explicit contentType", () => {
      const r = R2MultipartCreateSchema.safeParse({
        ...base,
        contentType: "application/octet-stream",
      });
      expect(r.success).toBe(true);
    });

    it("rejects extra fields (strict)", () => {
      const r = R2MultipartCreateSchema.safeParse({
        ...base,
        rogueField: "nope",
      });
      expect(r.success).toBe(false);
    });

    it("rejects a non-ULID cid", () => {
      const r = R2MultipartCreateSchema.safeParse({
        ...base,
        cid: "not-a-ulid",
      });
      expect(r.success).toBe(false);
    });

    it("rejects an empty contentType (must be 1..255 chars)", () => {
      const r = R2MultipartCreateSchema.safeParse({
        ...base,
        contentType: "",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("R2MultipartCompleteSchema", () => {
    const completeBase = {
      ...base,
      uploadId: "upload-abc-123",
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    };

    it("accepts a valid payload with one part", () => {
      expect(R2MultipartCompleteSchema.safeParse(completeBase).success).toBe(
        true,
      );
    });

    it("accepts an unsorted multi-part list (route + control sort internally)", () => {
      const r = R2MultipartCompleteSchema.safeParse({
        ...completeBase,
        parts: [
          { partNumber: 3, etag: '"e3"' },
          { partNumber: 1, etag: '"e1"' },
          { partNumber: 2, etag: '"e2"' },
        ],
      });
      expect(r.success).toBe(true);
    });

    it("rejects an empty parts array (matches S3 contract)", () => {
      const r = R2MultipartCompleteSchema.safeParse({
        ...completeBase,
        parts: [],
      });
      expect(r.success).toBe(false);
    });

    it("rejects partNumber out of S3 range (1..10000)", () => {
      for (const partNumber of [0, 10_001, 1.5, -1]) {
        const r = R2MultipartCompleteSchema.safeParse({
          ...completeBase,
          parts: [{ partNumber, etag: '"e"' }],
        });
        expect(r.success).toBe(false);
      }
    });

    it("rejects parts with empty etag", () => {
      const r = R2MultipartCompleteSchema.safeParse({
        ...completeBase,
        parts: [{ partNumber: 1, etag: "" }],
      });
      expect(r.success).toBe(false);
    });

    it("rejects missing uploadId", () => {
      const rest: Omit<typeof completeBase, "uploadId"> = {
        cid: completeBase.cid,
        bucket: completeBase.bucket,
        key: completeBase.key,
        parts: completeBase.parts,
      };
      const r = R2MultipartCompleteSchema.safeParse(rest);
      expect(r.success).toBe(false);
    });
  });

  describe("R2MultipartAbortSchema", () => {
    const abortBase = { ...base, uploadId: "upload-abc-123" };

    it("accepts a valid payload", () => {
      expect(R2MultipartAbortSchema.safeParse(abortBase).success).toBe(true);
    });

    it("rejects extra fields (strict — no `parts` smuggled through)", () => {
      const r = R2MultipartAbortSchema.safeParse({
        ...abortBase,
        parts: [{ partNumber: 1, etag: '"e"' }],
      });
      expect(r.success).toBe(false);
    });

    it("rejects empty uploadId", () => {
      const r = R2MultipartAbortSchema.safeParse({
        ...abortBase,
        uploadId: "",
      });
      expect(r.success).toBe(false);
    });
  });
});
