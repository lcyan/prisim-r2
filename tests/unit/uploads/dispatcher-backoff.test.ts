import { describe, it, expect } from "vitest";

import { ApiClientError } from "@/lib/api/client";
import { UploadError } from "@/lib/uploads/single-put";

// We test the pure helpers extracted from the dispatcher, not the full
// dispatcher loop — those still cover the meaningful surface area.
import {
  computeBackoffDelayMs,
  shouldGiveUp,
  isRateLimitedPresignError,
  MAX_RATE_LIMIT_ATTEMPTS,
} from "@/lib/uploads/dispatcher";

describe("computeBackoffDelayMs", () => {
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 8000], // capped
  ])("attempt %d → %dms", (attempt, expected) => {
    expect(computeBackoffDelayMs(attempt)).toBe(expected);
  });
});

describe("shouldGiveUp", () => {
  it("returns false for attempts under the max", () => {
    expect(shouldGiveUp(1)).toBe(false);
    expect(shouldGiveUp(MAX_RATE_LIMIT_ATTEMPTS - 1)).toBe(false);
  });
  it("returns true at or beyond the max", () => {
    expect(shouldGiveUp(MAX_RATE_LIMIT_ATTEMPTS)).toBe(true);
    expect(shouldGiveUp(MAX_RATE_LIMIT_ATTEMPTS + 1)).toBe(true);
  });
});

describe("isRateLimitedPresignError", () => {
  // ApiClientError constructor surface (verified in lib/api/client.ts):
  //   (code: ApiErrorCode, message: string, status: number, requestId: string, details?: unknown)
  // It's a plain `export class` with a public constructor — directly
  // constructible from tests.
  it("detects a wrapped rate_limited presign error", () => {
    const inner = new ApiClientError("rate_limited", "slow down", 429, "req1");
    const wrapped = new UploadError("presign", "presign failed", 429, inner);
    expect(isRateLimitedPresignError(wrapped)).toBe(inner);
  });

  it("detects a bare rate_limited ApiClientError", () => {
    const err = new ApiClientError("rate_limited", "slow down", 429, "req1");
    expect(isRateLimitedPresignError(err)).toBe(err);
  });

  it("returns null for non-rate-limited wrapped errors", () => {
    const inner = new ApiClientError(
      "auth.unauthorized",
      "no",
      401,
      "req1",
    );
    const wrapped = new UploadError("presign", "presign failed", 401, inner);
    expect(isRateLimitedPresignError(wrapped)).toBeNull();
  });

  it("returns null for non-presign UploadError kinds even if cause is rate_limited", () => {
    const inner = new ApiClientError("rate_limited", "slow down", 429, "req1");
    // Defensive: only kind='presign' is eligible. A kind='http' wrapping a
    // rate_limited ApiClientError (improbable but constructible) must NOT
    // trigger the presign retry path.
    const wrappedHttp = new UploadError("http", "boom", 429, inner);
    expect(isRateLimitedPresignError(wrappedHttp)).toBeNull();
    expect(
      isRateLimitedPresignError(new UploadError("network", "boom")),
    ).toBeNull();
    expect(
      isRateLimitedPresignError(new UploadError("aborted", "boom")),
    ).toBeNull();
  });

  it("returns null for arbitrary errors", () => {
    expect(isRateLimitedPresignError(new Error("oops"))).toBeNull();
    expect(isRateLimitedPresignError(null)).toBeNull();
    expect(isRateLimitedPresignError(undefined)).toBeNull();
    expect(isRateLimitedPresignError("rate_limited")).toBeNull();
    expect(isRateLimitedPresignError({ code: "rate_limited" })).toBeNull();
  });

  it("returns null for a presign UploadError whose cause is not an ApiClientError", () => {
    const wrapped = new UploadError(
      "presign",
      "presign failed",
      undefined,
      new Error("network blip"),
    );
    expect(isRateLimitedPresignError(wrapped)).toBeNull();
  });
});
