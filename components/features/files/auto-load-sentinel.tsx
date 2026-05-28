// components/features/files/auto-load-sentinel.tsx
//
// Tiny 1px div that fires `onIntersect` when scrolled into view. Drives
// the auto-load-more behavior above the object table — the parent
// (ObjectTable in Task 17) listens for the callback and calls
// `query.fetchNextPage()`. TanStack Query itself dedupes overlapping
// fetches, so the parent does not need its own in-flight guard.
//
// Why a separate component and not inline JSX in ObjectTable:
//   * The IntersectionObserver lifecycle is tied to a stable DOM node,
//     so it lives behind a useRef + useEffect pair. Lifting that into
//     ObjectTable would couple the table's render to the sentinel's
//     enabled flag in ways that are easy to break under conditional
//     rendering.
//   * Keeps the test surface tight — a 2-case component spec covers the
//     entire viewport-enter contract.

"use client";

import { useEffect, useRef } from "react";

export interface AutoLoadSentinelProps {
  /** True when more pages exist and auto-load should fire on intersect. */
  enabled: boolean;
  /** Called when the sentinel enters the viewport. The parent is
   *  responsible for the actual fetch — TanStack Query already dedupes
   *  duplicate `fetchNextPage` calls. */
  onIntersect: () => void;
}

export function AutoLoadSentinel({
  enabled,
  onIntersect,
}: AutoLoadSentinelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Latest-callback ref so we don't recreate the observer when `onIntersect`
  // identity changes (the parent typically rebuilds the closure each
  // render). The observer captures `cbRef.current` at fire time. The ref
  // is synced in a layout effect so the assignment doesn't violate the
  // "refs may not be written during render" rule.
  const cbRef = useRef(onIntersect);
  useEffect(() => {
    cbRef.current = onIntersect;
  }, [onIntersect]);

  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) cbRef.current();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return <div ref={ref} aria-hidden="true" style={{ height: 1 }} />;
}
