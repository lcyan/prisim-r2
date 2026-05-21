// components/features/dashboard/logo.tsx
//
// Brand mark for the dashboard header. Pure presentational — no client-side
// hooks, no events — so it can render in the server-component layout.

import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="flex items-baseline gap-2">
      <span className="font-display text-lg font-semibold tracking-tight">
        Prisim
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        R2 · edge console
      </span>
    </Link>
  );
}
