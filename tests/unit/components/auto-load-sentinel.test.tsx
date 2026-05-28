// tests/unit/components/auto-load-sentinel.test.tsx
//
// Spec for AutoLoadSentinel. The component wraps IntersectionObserver
// and we mock it via the global stub installed by
// tests/stubs/intersection-observer.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

import {
  lastObserver,
  resetObservers,
} from "@/tests/stubs/intersection-observer";
import { AutoLoadSentinel } from "@/components/features/files/auto-load-sentinel";

beforeEach(() => {
  resetObservers();
});

describe("AutoLoadSentinel", () => {
  it("calls onIntersect when the sentinel enters the viewport", () => {
    const onIntersect = vi.fn();
    render(<AutoLoadSentinel enabled={true} onIntersect={onIntersect} />);
    lastObserver().trigger(true);
    expect(onIntersect).toHaveBeenCalledTimes(1);
  });

  it("does not create an observer when disabled (no fire on intersect)", () => {
    const onIntersect = vi.fn();
    render(<AutoLoadSentinel enabled={false} onIntersect={onIntersect} />);
    expect(() => lastObserver()).toThrow();
    expect(onIntersect).not.toHaveBeenCalled();
  });
});
