// tests/unit/share/share-dialog.test.ts
//
// Pure-helper unit tests for the Share dialog's countdown formatter. We
// don't render React here — the formatter is the only logic worth
// asserting without a real DOM. The interactive bits (radio selection,
// post-mint Copy) are covered by manual QA + integration tests.

import { describe, it, expect } from "vitest";

import { formatRemaining } from "@/components/features/share/format-remaining";

describe("formatRemaining", () => {
  it("renders zero / negative as '00:00' (expired)", () => {
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(-100)).toBe("00:00");
  });

  it("renders sub-minute as MM:SS", () => {
    expect(formatRemaining(5_000)).toBe("00:05");
    expect(formatRemaining(59_000)).toBe("00:59");
  });

  it("renders sub-hour as MM:SS", () => {
    expect(formatRemaining(60_000)).toBe("01:00");
    expect(formatRemaining(75_000)).toBe("01:15");
  });

  it("renders sub-day as HH:MM:SS", () => {
    expect(formatRemaining(3_600_000)).toBe("01:00:00");
    expect(formatRemaining(3_600_000 + 65_000)).toBe("01:01:05");
  });

  it("renders multi-day as 'Nd HH:MM:SS'", () => {
    // Exactly 1 day: rolls over into the d-prefixed form.
    expect(formatRemaining(86_400_000)).toBe("1d 00:00:00");
    // 7 days minus 1s: the long-end UX of the 7d option.
    expect(formatRemaining(7 * 86_400_000 - 1000)).toBe("6d 23:59:59");
  });
});
