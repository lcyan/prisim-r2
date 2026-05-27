// tests/unit/api/client-ip.test.ts

import { describe, it, expect } from "vitest";

import { parseClientIp } from "@/lib/api/client-ip";

function headersWith(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("parseClientIp", () => {
  it("prefers cf-connecting-ip when set", () => {
    expect(
      parseClientIp(
        headersWith({
          "cf-connecting-ip": "1.2.3.4",
          "x-forwarded-for": "9.9.9.9, 10.10.10.10",
        }),
      ),
    ).toBe("1.2.3.4");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    expect(
      parseClientIp(headersWith({ "x-forwarded-for": "5.6.7.8, 9.10.11.12" })),
    ).toBe("5.6.7.8");
  });

  it("trims whitespace from both header forms", () => {
    expect(
      parseClientIp(headersWith({ "cf-connecting-ip": "  1.1.1.1  " })),
    ).toBe("1.1.1.1");
    expect(
      parseClientIp(headersWith({ "x-forwarded-for": "  2.2.2.2 , 3.3.3.3" })),
    ).toBe("2.2.2.2");
  });

  it("returns null when both headers are missing", () => {
    expect(parseClientIp(headersWith({}))).toBeNull();
  });

  it("returns null when cf-connecting-ip is empty/whitespace and xff missing", () => {
    expect(
      parseClientIp(headersWith({ "cf-connecting-ip": "   " })),
    ).toBeNull();
  });

  it("returns null when x-forwarded-for is empty string", () => {
    expect(parseClientIp(headersWith({ "x-forwarded-for": "" }))).toBeNull();
  });
});
