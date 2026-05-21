// tests/unit/format/connections.test.ts
//
// Pure-function spec for the account-ID mask helper. Locked down so that
// any future refactor that changes the truncation form (the UI relies on
// the ellipsis being U+2026 to render in JetBrains Mono) breaks the test.

import { describe, expect, it } from "vitest";

import { maskAccountId } from "@/lib/format/connections";

describe("maskAccountId", () => {
  it("compresses a 32-char hex ID to first4…last4", () => {
    expect(maskAccountId("8b21a3f4c705e6d09b8214f6c7a9b3d2")).toBe(
      "8b21…b3d2",
    );
  });

  it("uses the unicode horizontal ellipsis, not three dots", () => {
    // The font stack pairs the ellipsis with the surrounding mono digits;
    // a sequence of three periods would look wrong at small sizes.
    const masked = maskAccountId("00000000000000000000000000000000");
    expect(masked).toContain("…");
    expect(masked).not.toContain("...");
  });

  it("passes through strings shorter than 8 chars", () => {
    expect(maskAccountId("")).toBe("");
    expect(maskAccountId("abc")).toBe("abc");
    expect(maskAccountId("1234567")).toBe("1234567");
  });

  it("preserves leading and trailing characters exactly", () => {
    const masked = maskAccountId("abcd1111111111111111111111111efgh");
    expect(masked.startsWith("abcd")).toBe(true);
    expect(masked.endsWith("efgh")).toBe(true);
  });
});
