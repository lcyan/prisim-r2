"use client";

// components/features/dashboard/home-redirector.tsx
//
// Client-side bouncer rendered by app/page.tsx for authenticated users.
// Reads the persisted active-bucket selection from the Zustand store and
// jumps to the matching object browser route, so the header's bucket
// switcher and the main pane don't end up out of sync after a fresh load
// or a successful login.
//
// Why this is client-only:
//   * The decision depends on localStorage (the persisted Zustand slice),
//     which doesn't exist on the server. The auth gate stays on the server
//     side of app/page.tsx; this component just picks the destination.
//   * `createJSONStorage(() => localStorage)` hydrates synchronously during
//     store creation, so by the time this component's useEffect runs the
//     state already reflects what was last persisted — no hydration guard
//     needed (matches BucketSwitcher's usage pattern).

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { pickHomeRoute } from "@/components/features/dashboard/pick-home-route";
import { useActiveConnectionStore } from "@/stores/active-connection";

export function HomeRedirector() {
  const router = useRouter();

  useEffect(() => {
    // Read once via getState() instead of subscribing — we only need the
    // values at mount time, and re-running on store changes would double
    // up the router.replace after the first redirect.
    router.replace(pickHomeRoute(useActiveConnectionStore.getState()));
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        Loading…
      </p>
    </div>
  );
}
