import { describe, it, expect } from "vitest";

import { ApiClientError } from "@/lib/api/client";
import { UploadError } from "@/lib/uploads/single-put";

// We test the pure helpers extracted from the dispatcher, not the full
// dispatcher loop — those still cover the meaningful surface area.
import {
  computeBackoffDelayMs,
  shouldGiveUp,
  isRateLimitedPresignError,
  clearRetryBudget,
  MAX_RATE_LIMIT_ATTEMPTS,
} from "@/lib/uploads/dispatcher";

describe("computeBackoffDelayMs", () => {
  // With rng() === 0.5 the jitter multiplier is 0.85 + 0.5 * 0.3 = 1.0 → the
  // result matches the un-jittered base. That gives us the same boundary
  // assertions the original deterministic tests had, while exercising the new
  // signature.
  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 8000], // capped
  ])("attempt %d with neutral jitter → %dms", (attempt, expected) => {
    expect(computeBackoffDelayMs(attempt, () => 0.5)).toBe(expected);
  });

  it("attempt 0 → 0ms regardless of rng", () => {
    expect(computeBackoffDelayMs(0, () => 0)).toBe(0);
    expect(computeBackoffDelayMs(0, () => 1)).toBe(0);
    expect(computeBackoffDelayMs(-1, () => 0.5)).toBe(0);
  });

  it.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 8000],
  ])(
    "attempt %d stays within the ±15%% jitter envelope of base %dms",
    (attempt, base) => {
      const low = computeBackoffDelayMs(attempt, () => 0);
      const high = computeBackoffDelayMs(attempt, () => 1);
      // Lower edge: 0.85x, upper edge: 1.15x. Round() is applied inside the
      // helper so the comparisons use the pre-rounded fractions to match.
      expect(low).toBe(Math.round(base * 0.85));
      expect(high).toBe(Math.round(base * 1.15));
      // Spot-check the band actually moves — otherwise jitter is silently
      // disabled and the thundering-herd fix is a no-op.
      expect(high).toBeGreaterThan(low);
    },
  );

  it("uses Math.random by default (smoke test — value lies in the envelope)", () => {
    // Five samples is enough to detect "default is constant" without flake.
    for (let i = 0; i < 5; i++) {
      const v = computeBackoffDelayMs(1);
      expect(v).toBeGreaterThanOrEqual(Math.round(1000 * 0.85));
      expect(v).toBeLessThanOrEqual(Math.round(1000 * 1.15));
    }
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

describe("clearRetryBudget", () => {
  // The retryBudget map is module-private, so we can't read it directly. The
  // behavioral contract is "calling clearRetryBudget is always safe and a
  // no-op for unknown ids". The integration with the cancel/retry store
  // actions is exercised in tests/unit/uploads/dispatcher.test.ts where a
  // full runTask loop can observe the budget through retry behavior.
  it("does not throw for unknown ids", () => {
    expect(() => clearRetryBudget("01HF000000000000000000000Z")).not.toThrow();
  });
  it("is idempotent across repeated calls", () => {
    expect(() => {
      clearRetryBudget("dup");
      clearRetryBudget("dup");
      clearRetryBudget("dup");
    }).not.toThrow();
  });
});
