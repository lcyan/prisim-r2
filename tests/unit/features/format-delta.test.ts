import { describe, it, expect } from "vitest";
import { formatDelta } from "@/components/features/dashboard/format-delta";

describe("formatDelta", () => {
  it("returns null when previous is 0 and current is 0", () => {
    expect(formatDelta(0, 0)).toEqual(null);
  });

  it("returns +∞ marker when previous is 0 and current > 0", () => {
    expect(formatDelta(10, 0)).toEqual({
      direction: "up",
      pct: Infinity,
      label: "—",
    });
  });

  it("computes positive delta correctly", () => {
    expect(formatDelta(120, 100)).toEqual({
      direction: "up",
      pct: 20,
      label: "+20.0%",
    });
  });

  it("computes negative delta correctly", () => {
    expect(formatDelta(80, 100)).toEqual({
      direction: "down",
      pct: 20,
      label: "-20.0%",
    });
  });

  it("returns flat when previous and current are equal", () => {
    expect(formatDelta(100, 100)).toEqual({
      direction: "flat",
      pct: 0,
      label: "0.0%",
    });
  });

  it("rounds to 1 decimal", () => {
    expect(formatDelta(101, 100)).toEqual({
      direction: "up",
      pct: 1,
      label: "+1.0%",
    });
  });
});
