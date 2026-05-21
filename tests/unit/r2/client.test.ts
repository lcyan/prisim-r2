// tests/unit/r2/client.test.ts
//
// Spec for lib/r2/client.ts. Verifies that the factory:
//   - hands S3Client exactly the R2 config the rest of the lib assumes
//     (region 'auto', the derived account endpoint, path-style)
//   - forwards plaintext credentials verbatim (no transformation, no
//     leakage into other fields)
//   - returns a FRESH instance per call — see file header in client.ts;
//     caching would be a multi-tenant credential-bleed risk
//   - fails fast (TypeError) on empty/missing params BEFORE constructing
//     the client, so we never hand the SDK a half-formed endpoint URL

import { describe, expect, it, vi, beforeEach } from "vitest";

// Replace the real S3Client constructor with a spy that records the
// config it was called with. Plain `vi.fn()` is intentional — when JS
// invokes `new vi.fn()(config)` it allocates a fresh `this` object for
// us, so we get distinct instances per call AND captured ctor args
// without needing a `mockImplementation`. (Arrow-fn implementations
// don't work here: they can't be invoked with `new`.)
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(),
}));

import { S3Client } from "@aws-sdk/client-s3";
import { makeS3Client } from "@/lib/r2/client";

const validParams = {
  accountId: "abc123def",
  accessKeyId: "AKIATESTKEY",
  secretAccessKey: "shhh-secret",
};

function lastS3Config(): Record<string, unknown> {
  const calls = vi.mocked(S3Client).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("S3Client was not constructed");
  return last[0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(S3Client).mockClear();
});

describe("makeS3Client: S3Client config", () => {
  it("sets region to 'auto'", () => {
    makeS3Client(validParams);
    expect(lastS3Config()).toMatchObject({ region: "auto" });
  });

  it("builds the R2 endpoint from accountId", () => {
    makeS3Client(validParams);
    expect(lastS3Config()).toMatchObject({
      endpoint: "https://abc123def.r2.cloudflarestorage.com",
    });
  });

  it("sets forcePathStyle=true", () => {
    makeS3Client(validParams);
    expect(lastS3Config()).toMatchObject({ forcePathStyle: true });
  });

  it("forwards credentials inline (accessKeyId + secretAccessKey)", () => {
    makeS3Client(validParams);
    expect(lastS3Config()).toMatchObject({
      credentials: {
        accessKeyId: "AKIATESTKEY",
        secretAccessKey: "shhh-secret",
      },
    });
  });

  it("does not stash secrets on any other top-level config field", () => {
    // Belt-and-suspenders: if a future change accidentally splatted the
    // raw params object into S3Client's config, the secret would leak
    // onto fields like `accessKeyId` at the top level.
    makeS3Client(validParams);
    const cfg = lastS3Config();
    expect(cfg).not.toHaveProperty("accessKeyId");
    expect(cfg).not.toHaveProperty("secretAccessKey");
    expect(cfg).not.toHaveProperty("accountId");
  });
});

describe("makeS3Client: instance freshness", () => {
  it("returns a distinct client per call", () => {
    const a = makeS3Client(validParams);
    const b = makeS3Client(validParams);
    expect(a).not.toBe(b);
    expect(vi.mocked(S3Client)).toHaveBeenCalledTimes(2);
  });
});

describe("makeS3Client: input validation", () => {
  it.each([
    ["accountId", { ...validParams, accountId: "" }],
    ["accessKeyId", { ...validParams, accessKeyId: "" }],
    ["secretAccessKey", { ...validParams, secretAccessKey: "" }],
  ])(
    "throws TypeError before constructing S3Client when %s is empty",
    (_field, params) => {
      expect(() => makeS3Client(params)).toThrow(TypeError);
      expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
    },
  );

  it("throws when params is undefined (no nullable access blows up)", () => {
    expect(() =>
      makeS3Client(undefined as unknown as Parameters<typeof makeS3Client>[0]),
    ).toThrow();
    expect(vi.mocked(S3Client)).not.toHaveBeenCalled();
  });

  it("validation error message names the offending field", () => {
    try {
      makeS3Client({ ...validParams, accessKeyId: "" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect((e as Error).message).toContain("accessKeyId");
    }
  });
});
