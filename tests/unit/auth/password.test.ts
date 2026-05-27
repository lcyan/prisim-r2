// tests/unit/auth/password.test.ts
//
// Behaviour spec for lib/auth/password.ts. Iteration count is the real
// 600k figure — each hash takes ~150-300ms in Vitest's node runtime, so
// we keep the suite small.

import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("PBKDF2 password hashing", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(
      true,
    );
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword("Hunter2", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("generates a fresh salt for every hash", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    expect(a).not.toBe(b);
    // Both must still verify
    expect(await verifyPassword("same-input", a)).toBe(true);
    expect(await verifyPassword("same-input", b)).toBe(true);
  });

  it("emits the documented storage format", async () => {
    const hash = await hashPassword("x");
    expect(hash).toMatch(
      /^pbkdf2\$sha256\$600000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
  });

  it("returns false for malformed stored hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$600000$short")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha512$600000$AA==$AA==")).toBe(
      false,
    );
    expect(await verifyPassword("x", "argon2$sha256$600000$AA==$AA==")).toBe(
      false,
    );
  });

  it("rejects empty plaintext at hash time", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});
