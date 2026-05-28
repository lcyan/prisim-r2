import { describe, it, expect } from "vitest";

// We test the pure helper extracted in Step 3, not the full dispatcher loop.
import {
  computeBackoffDelayMs,
  shouldGiveUp,
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
