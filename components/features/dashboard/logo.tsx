// components/features/dashboard/logo.tsx
//
// Brand mark for the dashboard header. Pure presentational — no client-side
// hooks, no events — so it can render in the server-component layout.

import Link from "next/link";

import { PrismMark } from "@/components/brand/logo";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2">
      <PrismMark size={24} />
      <span className="flex items-baseline gap-2">
        <span className="font-display text-lg font-semibold tracking-tight">
          Prisim
        </span>
        <span className="text-xs text-muted-foreground">
          R2 · 边缘控制台
        </span>
      </span>
    </Link>
  );
}
