// tests/unit/r2/prefix.test.ts
//
// Spec for the prefix <-> URL segment helpers used by the object browser.
// Pure functions with no I/O, so the suite runs in vitest's node env with
// no jsdom / React tree setup.

import { describe, expect, it } from "vitest";

import {
  joinPrefix,
  prefixAtDepth,
  prefixToSegments,
  segmentsToPrefix,
} from "@/lib/r2/prefix";

describe("segmentsToPrefix", () => {
  it("returns '' for undefined / empty input (route shows bucket root)", () => {
    expect(segmentsToPrefix(undefined)).toBe("");
    expect(segmentsToPrefix([])).toBe("");
  });

  it("joins segments with '/' and appends a trailing slash", () => {
    expect(segmentsToPrefix(["a"])).toBe("a/");
    expect(segmentsToPrefix(["a", "b"])).toBe("a/b/");
    expect(segmentsToPrefix(["logs", "2026", "05"])).toBe("logs/2026/05/");
  });

  it("filters empty segments (defensive against '//' in URLs)", () => {
    expect(segmentsToPrefix(["", "a", "", "b"])).toBe("a/b/");
    expect(segmentsToPrefix(["", "", ""])).toBe("");
  });

  it("decodes URL-encoded segments — keys may contain spaces or '+'", () => {
    // Next.js' catch-all gives us URL-encoded segments; the API contract
    // is the decoded key.
    expect(segmentsToPrefix(["my%20folder"])).toBe("my folder/");
    expect(segmentsToPrefix(["a%2Bb"])).toBe("a+b/");
  });
});

describe("prefixToSegments", () => {
  it("returns [] for the root prefix", () => {
    expect(prefixToSegments("")).toEqual([]);
  });

  it("splits on '/' and drops empties (matches inverse of segmentsToPrefix)", () => {
    expect(prefixToSegments("a/")).toEqual(["a"]);
    expect(prefixToSegments("a/b/c/")).toEqual(["a", "b", "c"]);
    // Trailing slash is conventional; we accept inputs without it too so the
    // helper isn't fragile if a caller forgets.
    expect(prefixToSegments("a/b/c")).toEqual(["a", "b", "c"]);
  });

  it("collapses adjacent slashes", () => {
    expect(prefixToSegments("a//b///c/")).toEqual(["a", "b", "c"]);
  });
});

describe("joinPrefix", () => {
  it("appends a child to the bucket root", () => {
    expect(joinPrefix("", "logs")).toBe("logs/");
    expect(joinPrefix("", "logs/")).toBe("logs/");
  });

  it("appends to an existing prefix", () => {
    expect(joinPrefix("a/", "b")).toBe("a/b/");
    expect(joinPrefix("a/b/", "c")).toBe("a/b/c/");
  });

  it("tolerates a missing trailing slash on the parent (defensive)", () => {
    expect(joinPrefix("a", "b")).toBe("a/b/");
  });

  it("strips trailing slashes from the child before joining", () => {
    expect(joinPrefix("a/", "b/")).toBe("a/b/");
    expect(joinPrefix("a/", "b//")).toBe("a/b/");
  });

  it("returns the parent unchanged when the child is empty / slash-only", () => {
    expect(joinPrefix("a/", "")).toBe("a/");
    expect(joinPrefix("a/", "/")).toBe("a/");
  });
});

describe("prefixAtDepth", () => {
  it("returns '' for depth < 0 (the bucket-root crumb)", () => {
    expect(prefixAtDepth("a/b/c/", -1)).toBe("");
    expect(prefixAtDepth("a/b/c/", -5)).toBe("");
  });

  it("keeps the first depth+1 segments, with trailing slash", () => {
    expect(prefixAtDepth("a/b/c/", 0)).toBe("a/");
    expect(prefixAtDepth("a/b/c/", 1)).toBe("a/b/");
    expect(prefixAtDepth("a/b/c/", 2)).toBe("a/b/c/");
  });

  it("clamps to the full prefix when depth exceeds available segments", () => {
    // Don't over-extend with phantom slashes; clicking the last crumb
    // should land back on the same prefix.
    expect(prefixAtDepth("a/b/", 10)).toBe("a/b/");
  });

  it("returns '' when the prefix is empty regardless of depth", () => {
    expect(prefixAtDepth("", 0)).toBe("");
    expect(prefixAtDepth("", 5)).toBe("");
  });
});
