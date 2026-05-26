import { describe, it, expect } from "vitest";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@/lib/auth/recovery-codes";

describe("generateRecoveryCodes", () => {
  it("returns 10 unique base32 codes with hyphen separator", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      // 4 chars + '-' + 4 chars (e.g. ABCD-2345)
      expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });
});

describe("normalizeRecoveryCode", () => {
  it("uppercases + strips whitespace + accepts with or without hyphen", () => {
    expect(normalizeRecoveryCode("abcd-2345")).toBe("ABCD-2345");
    expect(normalizeRecoveryCode("abcd2345")).toBe("ABCD-2345");
    expect(normalizeRecoveryCode(" abcd 2345 ")).toBe("ABCD-2345");
  });

  it("returns null for invalid shape", () => {
    expect(normalizeRecoveryCode("abc")).toBeNull();
    expect(normalizeRecoveryCode("abcd-2345-extra")).toBeNull();
    // 0/1 not in base32 alphabet
    expect(normalizeRecoveryCode("ABCD-2301")).toBeNull();
  });
});

describe("hashRecoveryCode", () => {
  const userA = "01H000000000000000000000A";
  const userB = "01H000000000000000000000B";

  it("returns hex hmac-sha256, deterministic, normalized before hashing", async () => {
    const a = await hashRecoveryCode("abcd-2345", userA);
    const b = await hashRecoveryCode("ABCD2345", userA);
    const c = await hashRecoveryCode("ABCD-2345", userA);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("differs across codes", async () => {
    const a = await hashRecoveryCode("ABCD-2345", userA);
    const b = await hashRecoveryCode("EFGH-6789", userA);
    expect(a).not.toBe(b);
  });

  it("differs across users for the same code (per-user HMAC key)", async () => {
    const a = await hashRecoveryCode("ABCD-2345", userA);
    const b = await hashRecoveryCode("ABCD-2345", userB);
    expect(a).not.toBe(b);
  });
});
