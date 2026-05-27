// tests/unit/api/path-id.test.ts

import { describe, it, expect } from "vitest";

import { pathSegmentFromEnd } from "@/lib/api/path-id";

describe("pathSegmentFromEnd", () => {
  it("returns the last segment at offset 0", () => {
    expect(pathSegmentFromEnd("https://x/api/share/abc123", 0)).toBe("abc123");
  });

  it("returns the second-to-last segment at offset 1", () => {
    expect(pathSegmentFromEnd("https://x/api/share/abc123/reveal", 1)).toBe(
      "abc123",
    );
  });

  it("ignores a trailing slash on the pathname", () => {
    expect(pathSegmentFromEnd("https://x/api/connections/01ABC/", 0)).toBe(
      "01ABC",
    );
  });

  it("ignores a query string", () => {
    expect(pathSegmentFromEnd("https://x/api/share/abc?foo=bar", 0)).toBe(
      "abc",
    );
  });

  it("returns '' when the path is shorter than the requested offset", () => {
    expect(pathSegmentFromEnd("https://x/", 0)).toBe("");
    expect(pathSegmentFromEnd("https://x/api/share/abc", 5)).toBe("");
  });
});
