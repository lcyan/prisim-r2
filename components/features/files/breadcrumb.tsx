"use client";

// components/features/files/breadcrumb.tsx
//
// Hierarchical breadcrumb for the bucket browser.
//
//   <bucket name> ▸ a ▸ b ▸ c       (current is `a/b/c/`)
//
// The bucket name is the leftmost crumb and navigates back to the bucket root.
// Each path segment is its own crumb and navigates to the prefix that ends at
// that depth. The last crumb is rendered as the current location (non-active
// styling) but is still a button so keyboard users can press Enter without a
// branch in the markup.
//
// Why a separate component (not inlined in the page):
//   * The same breadcrumb might be reused on adjacent surfaces (the future
//     share / preview drawer headers).
//   * Pure presentational. Easy to unit-test the prefix → segments mapping
//     via the lib/r2/prefix helpers without rendering React.

import { ChevronRight } from "lucide-react";

import { prefixToSegments } from "@/lib/r2/prefix";
import { cn } from "@/lib/utils";

const T = {
  breadcrumbLabel: "面包屑导航",
  noBucket: "（未选择 bucket）",
} as const;

export interface FileBreadcrumbProps {
  /** R2 bucket name — shown as the leftmost (root) crumb. */
  bucket: string;
  /** R2-style prefix string ("" or ends with "/"). Parsed into segments
   *  for rendering. */
  prefix: string;
  /**
   * Called when the user clicks a crumb.
   *
   *   depth = -1   → bucket root (prefix should become "")
   *   depth >=  0  → 0-based index of the segment that was clicked, where
   *                  prefix = "a/b/c/" → ["a", "b", "c"] at depths 0,1,2
   *
   * The parent maps this to a URL push — keeping the depth callback contract
   * pure makes the component trivially testable.
   */
  onNavigate: (depth: number) => void;
  className?: string;
}

export function FileBreadcrumb({
  bucket,
  prefix,
  onNavigate,
  className,
}: FileBreadcrumbProps) {
  const segments = prefixToSegments(prefix);

  return (
    <nav
      aria-label={T.breadcrumbLabel}
      className={cn(
        "flex min-w-0 items-baseline gap-1 overflow-hidden",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onNavigate(-1)}
        className={cn(
          "font-display text-2xl font-semibold tracking-tight transition-colors",
          // The root crumb is "active" when we're already at the bucket root
          // (no segments). Subtle styling difference keeps the eye trained on
          // where the user is right now.
          segments.length === 0
            ? "text-foreground"
            : "text-foreground hover:text-primary",
        )}
      >
        {bucket || T.noBucket}
      </button>

      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={`${i}-${seg}`} className="flex items-baseline gap-1">
            <ChevronRight
              className="mx-0.5 h-3.5 w-3.5 self-center text-muted-foreground"
              aria-hidden
            />
            <button
              type="button"
              onClick={() => onNavigate(i)}
              aria-current={isLast ? "page" : undefined}
              className={cn(
                "max-w-[16ch] truncate font-mono text-sm transition-colors",
                isLast
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
