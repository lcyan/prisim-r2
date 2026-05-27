// tests/unit/auth/csrf.test.ts
//
// Behavioural spec for lib/auth/csrf.ts:
//   - generateCsrfToken returns enough entropy and a fresh value each call
//   - hashCsrfToken is deterministic + 64-char hex (sha256)
//   - timingSafeEqual rejects length mismatches and value differences
//   - buildCsrfCookie composes a spec-compliant Set-Cookie header value

import { describe, expect, it } from "vitest";
import {
  buildCsrfCookie,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
  hashCsrfToken,
  timingSafeEqual,
} from "@/lib/auth/csrf";

describe("generateCsrfToken", () => {
  it("returns a base64url string ≥ 32 chars (≥ 24-byte entropy)", () => {
    const t = generateCsrfToken();
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.endsWith("=")).toBe(false);
  });

  it("emits a different token on each call", () => {
    const xs = new Set(Array.from({ length: 20 }, () => generateCsrfToken()));
    expect(xs.size).toBe(20);
  });
});

describe("hashCsrfToken", () => {
  it("is deterministic", async () => {
    const a = await hashCsrfToken("token-abc");
    const b = await hashCsrfToken("token-abc");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    expect(await hashCsrfToken("a")).not.toBe(await hashCsrfToken("b"));
  });

  it("returns 64-char lowercase hex (sha256)", async () => {
    const h = await hashCsrfToken("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("abcd", "abcd")).toBe(true);
  });

  it("returns false for value mismatch of equal length", () => {
    expect(timingSafeEqual("abcd", "abce")).toBe(false);
  });

  it("returns false for length mismatch (does not throw)", () => {
    expect(timingSafeEqual("a", "ab")).toBe(false);
  });
});

describe("buildCsrfCookie", () => {
  it("sets path, max-age, SameSite=Lax, and is not HttpOnly", () => {
    const cookie = buildCsrfCookie("the-token", {
      maxAgeSeconds: 60,
      secure: false,
    });
    expect(cookie).toMatch(new RegExp(`^${CSRF_COOKIE_NAME}=the-token`));
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=60");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("HttpOnly");
  });

  it("appends Secure when opts.secure=true", () => {
    expect(buildCsrfCookie("t", { maxAgeSeconds: 30, secure: true })).toContain(
      "Secure",
    );
  });

  it("omits Secure when opts.secure=false", () => {
    expect(
      buildCsrfCookie("t", { maxAgeSeconds: 30, secure: false }),
    ).not.toContain("Secure");
  });
});
