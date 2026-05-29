// tests/unit/r2/control.test.ts
//
// Spec for lib/r2/control.ts. Each wrapper is exercised against a fake
// S3Client whose `.send` is a vi.fn — the helpers only call `send`, so
// we don't need to mock the whole AWS module. Keeping the real Command
// classes lets us assert on the actual `.input` payload the SDK would
// serialize (catches Bucket vs bucket and PartNumber vs partNumber
// typos that whole-module mocks miss).
//
// What this file covers (mapped to subtask 9.5 acceptance):
//   - Happy paths: correct Command class, correct input fields,
//     correct result mapping for every wrapper.
//   - listObjects: ContinuationToken plumbing, IsTruncated default,
//     filtering of entries without a usable Key.
//   - deleteObjects: empty-array short-circuit (no SDK call), batching
//     at the 1000-key boundary (1001 keys → 2 commands), aggregation
//     of Deleted+Errors across batches.
//   - completeMultipartUpload: parts sorted ascending by partNumber,
//     ETag/PartNumber field mapping, non-empty parts validation.
//   - abortMultipartUpload: returns void, sends the right Command.
//   - listBuckets: tolerates missing Buckets in response, maps fields.
//   - createMultipartUpload: surfaces explicit error if R2 returns no
//     UploadId (defends against a silent "" propagating downstream).
//   - Validation: every wrapper rejects empty strings / non-positive
//     ints BEFORE calling send, with TypeError (programmer bug, not
//     an upstream issue).
//   - Error mapping: credential failures → R2CredentialError,
//     generic SDK failures → R2UpstreamError with code+httpStatus
//     preserved. Tested across multiple wrappers to lock the contract
//     that every catch routes through mapR2Error.

import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObjects,
  listBuckets,
  listObjects,
  summarizeBucketUsage,
} from "@/lib/r2/control";

// A throwaway client that records every command and replies with
// whatever the caller queued up. We rebuild it per test to avoid
// cross-test leakage.
function makeClient(
  respond: (cmd: unknown) => unknown | Promise<unknown> = () => ({}),
) {
  const send = vi.fn(async (cmd: unknown) => respond(cmd));
  return {
    send,
    client: { send } as unknown as S3Client,
  };
}

describe("listObjects", () => {
  it("sends ListObjectsV2Command with bucket/prefix/token/maxKeys", async () => {
    const { client, send } = makeClient(() => ({}));
    await listObjects({
      client,
      bucket: "b",
      prefix: "p/",
      continuationToken: "tok-1",
      maxKeys: 50,
    });
    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(ListObjectsV2Command);
    expect((cmd as ListObjectsV2Command).input).toMatchObject({
      Bucket: "b",
      Prefix: "p/",
      ContinuationToken: "tok-1",
      MaxKeys: 50,
    });
  });

  it("maps Contents → items and forwards NextContinuationToken", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { client } = makeClient(() => ({
      Contents: [
        { Key: "a.txt", Size: 10, ETag: "etag-a", LastModified: now },
        { Key: "b.txt", Size: 20 },
      ],
      NextContinuationToken: "next-tok",
      IsTruncated: true,
    }));
    const res = await listObjects({ client, bucket: "b" });
    expect(res.items).toEqual([
      { key: "a.txt", size: 10, etag: "etag-a", lastModified: now },
      { key: "b.txt", size: 20, etag: undefined, lastModified: undefined },
    ]);
    expect(res.continuationToken).toBe("next-tok");
    expect(res.isTruncated).toBe(true);
  });

  it("defaults isTruncated to false when SDK omits it", async () => {
    const { client } = makeClient(() => ({ Contents: [] }));
    const res = await listObjects({ client, bucket: "b" });
    expect(res.isTruncated).toBe(false);
    expect(res.continuationToken).toBeUndefined();
    expect(res.items).toEqual([]);
    // Stable empty-page shape: prefixes is always an array, even when
    // delimiter wasn't supplied. Consumers don't need to `?? []`.
    expect(res.prefixes).toEqual([]);
  });

  it("filters out Contents entries with no Key (defensive)", async () => {
    const { client } = makeClient(() => ({
      Contents: [{ Key: "good.txt", Size: 1 }, { Size: 1 }, { Key: "" }],
    }));
    const res = await listObjects({ client, bucket: "b" });
    expect(res.items.map((i) => i.key)).toEqual(["good.txt"]);
  });

  it("forwards Delimiter to the SDK and surfaces CommonPrefixes as prefixes", async () => {
    const { client, send } = makeClient(() => ({
      Contents: [{ Key: "a/file.txt", Size: 1 }],
      CommonPrefixes: [{ Prefix: "a/sub1/" }, { Prefix: "a/sub2/" }],
      NextContinuationToken: "next-tok",
    }));
    const res = await listObjects({
      client,
      bucket: "b",
      prefix: "a/",
      delimiter: "/",
    });

    const cmd = send.mock.calls[0]![0] as ListObjectsV2Command;
    expect(cmd.input).toMatchObject({
      Bucket: "b",
      Prefix: "a/",
      Delimiter: "/",
    });
    expect(res.items.map((i) => i.key)).toEqual(["a/file.txt"]);
    expect(res.prefixes).toEqual(["a/sub1/", "a/sub2/"]);
    expect(res.continuationToken).toBe("next-tok");
  });

  it("filters CommonPrefixes entries with missing/empty Prefix (defensive)", async () => {
    // SDK types each CommonPrefixes entry's Prefix as optional. R2
    // never returns this in practice, but a "" sentinel would create
    // an empty folder card in the UI — drop them at the boundary.
    const { client } = makeClient(() => ({
      CommonPrefixes: [{ Prefix: "kept/" }, { Prefix: "" }, {}],
    }));
    const res = await listObjects({ client, bucket: "b", delimiter: "/" });
    expect(res.prefixes).toEqual(["kept/"]);
  });

  it("omits Delimiter from the SDK call when not supplied (flat listing)", async () => {
    const { client, send } = makeClient(() => ({ Contents: [] }));
    await listObjects({ client, bucket: "b" });
    const cmd = send.mock.calls[0]![0] as ListObjectsV2Command;
    // The route layer relies on omission to keep listings flat for
    // routes that haven't opted into folder mode. Asserting on the
    // SDK input field (rather than the typed Delimiter) keeps the
    // contract aligned with what AWS SDK actually serializes.
    expect(cmd.input.Delimiter).toBeUndefined();
  });

  it("rejects empty bucket with TypeError before send", async () => {
    const { client, send } = makeClient();
    await expect(listObjects({ client, bucket: "" })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects non-positive maxKeys with TypeError", async () => {
    const { client } = makeClient();
    await expect(
      listObjects({ client, bucket: "b", maxKeys: 0 }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects empty delimiter with TypeError before send", async () => {
    const { client, send } = makeClient();
    await expect(
      listObjects({ client, bucket: "b", delimiter: "" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("summarizeBucketUsage", () => {
  it("scans flat object pages and totals bytes", async () => {
    const responses = [
      {
        Contents: [
          { Key: "a.txt", Size: 10 },
          { Key: "nested/b.bin", Size: 20 },
        ],
        IsTruncated: true,
        NextContinuationToken: "next-1",
      },
      {
        Contents: [{ Key: "c.txt", Size: 5 }],
        IsTruncated: false,
      },
    ];
    const { client, send } = makeClient(() => responses.shift() ?? {});

    await expect(
      summarizeBucketUsage({
        client,
        bucket: "assets",
        maxObjects: 20_000,
        maxPages: 20,
      }),
    ).resolves.toEqual({ objectCount: 3, totalBytes: 35, truncated: false });

    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![0] as ListObjectsV2Command).input).toMatchObject({
      Bucket: "assets",
      MaxKeys: 1000,
    });
    expect((send.mock.calls[1]![0] as ListObjectsV2Command).input).toMatchObject({
      Bucket: "assets",
      ContinuationToken: "next-1",
      MaxKeys: 1000,
    });
  });

  it("marks results truncated when the object cap is reached", async () => {
    const { client } = makeClient(() => ({
      Contents: [
        { Key: "a.txt", Size: 10 },
        { Key: "b.txt", Size: 20 },
      ],
      IsTruncated: true,
      NextContinuationToken: "next-1",
    }));

    await expect(
      summarizeBucketUsage({
        client,
        bucket: "assets",
        maxObjects: 1,
        maxPages: 20,
      }),
    ).resolves.toEqual({ objectCount: 1, totalBytes: 10, truncated: true });
  });
});

describe("deleteObjects", () => {
  it("returns empty result without calling SDK when keys is empty", async () => {
    const { client, send } = makeClient();
    const res = await deleteObjects({ client, bucket: "b", keys: [] });
    expect(send).not.toHaveBeenCalled();
    expect(res).toEqual({ deleted: [], errors: [] });
  });

  it("sends one DeleteObjectsCommand for ≤1000 keys with full payload", async () => {
    const { client, send } = makeClient(() => ({
      Deleted: [{ Key: "a" }, { Key: "b" }],
      Errors: [{ Key: "c", Code: "AccessDenied", Message: "nope" }],
    }));
    const res = await deleteObjects({
      client,
      bucket: "b",
      keys: ["a", "b", "c"],
    });

    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0]![0] as DeleteObjectsCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectsCommand);
    expect(cmd.input).toMatchObject({
      Bucket: "b",
      Delete: {
        Objects: [{ Key: "a" }, { Key: "b" }, { Key: "c" }],
      },
    });
    expect(res).toEqual({
      deleted: ["a", "b"],
      errors: [{ key: "c", code: "AccessDenied", message: "nope" }],
    });
  });

  it("chunks at the 1000-key boundary (1001 keys → 2 commands)", async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `k-${i}`);
    const { client, send } = makeClient((cmd) => ({
      Deleted: (cmd as DeleteObjectsCommand).input.Delete!.Objects!.map(
        (o) => ({ Key: o.Key }),
      ),
    }));
    const res = await deleteObjects({ client, bucket: "b", keys });

    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0]![0] as DeleteObjectsCommand).input.Delete!
      .Objects!;
    const second = (send.mock.calls[1]![0] as DeleteObjectsCommand).input
      .Delete!.Objects!;
    expect(first).toHaveLength(1000);
    expect(second).toHaveLength(1);
    expect(second[0]!.Key).toBe("k-1000");
    expect(res.deleted).toHaveLength(1001);
  });

  it("aggregates Deleted + Errors across multiple batches", async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `k-${i}`);
    let call = 0;
    const { client } = makeClient(() => {
      call++;
      if (call === 1) {
        return {
          Deleted: [{ Key: "k-0" }],
          Errors: [{ Key: "k-1", Code: "InternalError" }],
        };
      }
      return {
        Deleted: [{ Key: "k-1000" }],
        Errors: [{ Key: "k-999-extra", Code: "Slow" }],
      };
    });
    const res = await deleteObjects({ client, bucket: "b", keys });
    expect(res.deleted).toEqual(["k-0", "k-1000"]);
    expect(res.errors).toEqual([
      { key: "k-1", code: "InternalError", message: undefined },
      { key: "k-999-extra", code: "Slow", message: undefined },
    ]);
  });

  it("rejects non-array keys with TypeError", async () => {
    const { client } = makeClient();
    await expect(
      deleteObjects({
        client,
        bucket: "b",
        keys: "a,b" as unknown as string[],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects empty bucket before any send", async () => {
    const { client, send } = makeClient();
    await expect(
      deleteObjects({ client, bucket: "", keys: ["a"] }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createMultipartUpload", () => {
  it("sends CreateMultipartUploadCommand and returns uploadId", async () => {
    const { client, send } = makeClient(() => ({ UploadId: "u-1" }));
    const res = await createMultipartUpload({
      client,
      bucket: "b",
      key: "big.bin",
      contentType: "application/octet-stream",
    });
    expect(res).toEqual({ uploadId: "u-1" });
    const cmd = send.mock.calls[0]![0] as CreateMultipartUploadCommand;
    expect(cmd).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(cmd.input).toMatchObject({
      Bucket: "b",
      Key: "big.bin",
      ContentType: "application/octet-stream",
    });
  });

  it("omits ContentType when not supplied", async () => {
    const { client, send } = makeClient(() => ({ UploadId: "u-1" }));
    await createMultipartUpload({ client, bucket: "b", key: "k" });
    const cmd = send.mock.calls[0]![0] as CreateMultipartUploadCommand;
    expect("ContentType" in cmd.input).toBe(false);
  });

  it("throws loudly when R2 returns no UploadId", async () => {
    const { client } = makeClient(() => ({}));
    await expect(
      createMultipartUpload({ client, bucket: "b", key: "k" }),
    ).rejects.toMatchObject({ name: "R2UpstreamError" });
  });

  it.each([
    ["bucket", { bucket: "", key: "k" }],
    ["key", { bucket: "b", key: "" }],
  ])("rejects empty %s with TypeError", async (_field, override) => {
    const { client, send } = makeClient();
    await expect(
      createMultipartUpload({ client, ...override }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("completeMultipartUpload", () => {
  const base = {
    bucket: "b",
    key: "big.bin",
    uploadId: "u-1",
  };

  it("sends CompleteMultipartUploadCommand with parts sorted ascending", async () => {
    const { client, send } = makeClient(() => ({
      ETag: "final-etag",
      Location: "https://r2/big.bin",
    }));
    const res = await completeMultipartUpload({
      client,
      ...base,
      parts: [
        { partNumber: 3, etag: "e3" },
        { partNumber: 1, etag: "e1" },
        { partNumber: 2, etag: "e2" },
      ],
    });

    const cmd = send.mock.calls[0]![0] as CompleteMultipartUploadCommand;
    expect(cmd).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(cmd.input.MultipartUpload!.Parts).toEqual([
      { PartNumber: 1, ETag: "e1" },
      { PartNumber: 2, ETag: "e2" },
      { PartNumber: 3, ETag: "e3" },
    ]);
    expect(res).toEqual({ etag: "final-etag", location: "https://r2/big.bin" });
  });

  it("does not mutate the caller's parts array", async () => {
    const { client } = makeClient(() => ({}));
    const parts = [
      { partNumber: 2, etag: "e2" },
      { partNumber: 1, etag: "e1" },
    ];
    const snapshot = parts.map((p) => ({ ...p }));
    await completeMultipartUpload({ client, ...base, parts });
    expect(parts).toEqual(snapshot);
  });

  it("rejects empty parts array with TypeError", async () => {
    const { client, send } = makeClient();
    await expect(
      completeMultipartUpload({ client, ...base, parts: [] }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects parts with non-positive partNumber", async () => {
    const { client } = makeClient();
    await expect(
      completeMultipartUpload({
        client,
        ...base,
        parts: [{ partNumber: 0, etag: "e" }],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects parts with empty etag", async () => {
    const { client } = makeClient();
    await expect(
      completeMultipartUpload({
        client,
        ...base,
        parts: [{ partNumber: 1, etag: "" }],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    ["bucket", { ...base, bucket: "" }],
    ["key", { ...base, key: "" }],
    ["uploadId", { ...base, uploadId: "" }],
  ])("rejects empty %s with TypeError", async (_field, override) => {
    const { client } = makeClient();
    await expect(
      completeMultipartUpload({
        client,
        ...override,
        parts: [{ partNumber: 1, etag: "e" }],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("abortMultipartUpload", () => {
  it("sends AbortMultipartUploadCommand and resolves to void", async () => {
    const { client, send } = makeClient(() => ({}));
    const res = await abortMultipartUpload({
      client,
      bucket: "b",
      key: "k",
      uploadId: "u-1",
    });
    expect(res).toBeUndefined();
    const cmd = send.mock.calls[0]![0] as AbortMultipartUploadCommand;
    expect(cmd).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(cmd.input).toMatchObject({
      Bucket: "b",
      Key: "k",
      UploadId: "u-1",
    });
  });

  it.each([
    ["bucket", { bucket: "", key: "k", uploadId: "u" }],
    ["key", { bucket: "b", key: "", uploadId: "u" }],
    ["uploadId", { bucket: "b", key: "k", uploadId: "" }],
  ])("rejects empty %s with TypeError", async (_field, override) => {
    const { client, send } = makeClient();
    await expect(
      abortMultipartUpload({ client, ...override }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("listBuckets", () => {
  it("sends ListBucketsCommand and maps Buckets to {name, creationDate}", async () => {
    const now = new Date("2026-02-02T00:00:00Z");
    const { client, send } = makeClient(() => ({
      Buckets: [{ Name: "alpha", CreationDate: now }, { Name: "beta" }],
    }));
    const res = await listBuckets({ client });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(ListBucketsCommand);
    expect(res).toEqual([
      { name: "alpha", creationDate: now },
      { name: "beta", creationDate: undefined },
    ]);
  });

  it("returns [] when SDK response has no Buckets field", async () => {
    const { client } = makeClient(() => ({}));
    await expect(listBuckets({ client })).resolves.toEqual([]);
  });
});

describe("control wrappers: upstream error mapping", () => {
  function credError() {
    return Object.assign(new Error("nope"), { name: "InvalidAccessKeyId" });
  }
  function upstreamError() {
    return Object.assign(new Error("boom"), {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    });
  }

  it("listObjects credential failure → R2CredentialError", async () => {
    const { client } = makeClient(() => {
      throw credError();
    });
    await expect(listObjects({ client, bucket: "b" })).rejects.toMatchObject({
      name: "R2CredentialError",
    });
  });

  it("listObjects generic failure → R2UpstreamError with code+httpStatus", async () => {
    const { client } = makeClient(() => {
      throw upstreamError();
    });
    await expect(listObjects({ client, bucket: "b" })).rejects.toMatchObject({
      name: "R2UpstreamError",
      code: "InternalError",
      httpStatus: 500,
    });
  });

  it("deleteObjects upstream failure on batch N is mapped (not raw SDK error)", async () => {
    const { client } = makeClient(() => {
      throw upstreamError();
    });
    await expect(
      deleteObjects({ client, bucket: "b", keys: ["a"] }),
    ).rejects.toMatchObject({ name: "R2UpstreamError", code: "InternalError" });
  });

  it("createMultipartUpload credential failure → R2CredentialError", async () => {
    const { client } = makeClient(() => {
      throw credError();
    });
    await expect(
      createMultipartUpload({ client, bucket: "b", key: "k" }),
    ).rejects.toMatchObject({ name: "R2CredentialError" });
  });

  it("completeMultipartUpload upstream failure → R2UpstreamError", async () => {
    const { client } = makeClient(() => {
      throw upstreamError();
    });
    await expect(
      completeMultipartUpload({
        client,
        bucket: "b",
        key: "k",
        uploadId: "u",
        parts: [{ partNumber: 1, etag: "e" }],
      }),
    ).rejects.toMatchObject({ name: "R2UpstreamError", code: "InternalError" });
  });

  it("abortMultipartUpload upstream failure → R2UpstreamError", async () => {
    const { client } = makeClient(() => {
      throw upstreamError();
    });
    await expect(
      abortMultipartUpload({
        client,
        bucket: "b",
        key: "k",
        uploadId: "u",
      }),
    ).rejects.toMatchObject({ name: "R2UpstreamError" });
  });

  it("listBuckets credential failure → R2CredentialError", async () => {
    const { client } = makeClient(() => {
      throw credError();
    });
    await expect(listBuckets({ client })).rejects.toMatchObject({
      name: "R2CredentialError",
    });
  });
});
