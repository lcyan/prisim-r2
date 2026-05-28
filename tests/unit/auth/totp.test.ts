// tests/unit/auth/totp.test.ts
//
// RFC 6238 测试向量 + ±1 step 容差 + base32 编/解码。

import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  buildOtpauthUri,
} from "@/lib/auth/totp";

// RFC 6238 §B 附录:secret 是 ASCII "12345678901234567890" 的字节。
// 时间戳 59 → step 1 → code 287082 (HOTP 截取后 6 位)
const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_BYTES = new TextEncoder().encode(RFC_SECRET_ASCII);

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const encoded = base32Encode(original);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(encoded)).toEqual(original);
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("invalid-base32-1!")).toThrow();
  });
});

describe("generateTotpCode", () => {
  it("returns 287082 for RFC 6238 §B at t=59 (sha1)", async () => {
    const code = await generateTotpCode(RFC_SECRET_BYTES, 59);
    expect(code).toBe("287082");
  });

  it("returns 081804 for RFC 6238 §B at t=1111111109 (sha1)", async () => {
    const code = await generateTotpCode(RFC_SECRET_BYTES, 1111111109);
    expect(code).toBe("081804");
  });
});

describe("verifyTotpCode (±1 step)", () => {
  it("accepts current step", async () => {
    const t = 1700000000;
    const code = await generateTotpCode(RFC_SECRET_BYTES, t);
    const result = await verifyTotpCode(RFC_SECRET_BYTES, code, t);
    expect(result.ok).toBe(true);
    expect(result.matchedStep).toBe(Math.floor(t / 30));
  });

  it("accepts whitespace-grouped codes from password managers", async () => {
    const t = 1700000000;
    const code = await generateTotpCode(RFC_SECRET_BYTES, t);
    const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;
    const result = await verifyTotpCode(RFC_SECRET_BYTES, grouped, t);
    expect(result.ok).toBe(true);
    expect(result.matchedStep).toBe(Math.floor(t / 30));
  });

  it("accepts previous step (clock drift +30s)", async () => {
    const t = 1700000000;
    const earlierCode = await generateTotpCode(RFC_SECRET_BYTES, t - 30);
    const result = await verifyTotpCode(RFC_SECRET_BYTES, earlierCode, t);
    expect(result.ok).toBe(true);
    expect(result.matchedStep).toBe(Math.floor((t - 30) / 30));
  });

  it("accepts next step (clock drift -30s)", async () => {
    const t = 1700000000;
    const laterCode = await generateTotpCode(RFC_SECRET_BYTES, t + 30);
    const result = await verifyTotpCode(RFC_SECRET_BYTES, laterCode, t);
    expect(result.ok).toBe(true);
  });

  it("rejects out-of-window code (-60s)", async () => {
    const t = 1700000000;
    const old = await generateTotpCode(RFC_SECRET_BYTES, t - 60);
    const result = await verifyTotpCode(RFC_SECRET_BYTES, old, t);
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric / wrong length", async () => {
    const t = 1700000000;
    expect((await verifyTotpCode(RFC_SECRET_BYTES, "12345", t)).ok).toBe(false);
    expect((await verifyTotpCode(RFC_SECRET_BYTES, "abcdef", t)).ok).toBe(
      false,
    );
    expect((await verifyTotpCode(RFC_SECRET_BYTES, "1234567", t)).ok).toBe(
      false,
    );
  });
});

describe("generateTotpSecret", () => {
  it("returns 20 random bytes", () => {
    const s1 = generateTotpSecret();
    const s2 = generateTotpSecret();
    expect(s1.byteLength).toBe(20);
    expect(s2.byteLength).toBe(20);
    expect(s1).not.toEqual(s2);
  });
});

describe("buildOtpauthUri", () => {
  it("encodes issuer + email with proper URL escaping", () => {
    const secret = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21]); // "Hello!"
    const uri = buildOtpauthUri({
      issuer: "Prisim R2",
      label: "admin@example.com",
      secret,
    });
    expect(uri).toMatch(
      /^otpauth:\/\/totp\/Prisim%20R2:admin%40example\.com\?/,
    );
    expect(uri).toContain("issuer=Prisim%20R2");
    expect(uri).toContain("secret=" + base32Encode(secret));
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
