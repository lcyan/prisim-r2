"use client";

// components/features/dashboard/home-redirector.tsx
//
// Client-side bouncer rendered by app/page.tsx for authenticated users.
// Now goes to /dashboard unconditionally (except when middleware passed
// a callbackUrl mid-navigation, which the underlying pickHomeRoute honors).

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { pickHomeRoute } from "@/components/features/dashboard/pick-home-route";
import { useActiveConnectionStore } from "@/stores/active-connection";

export function HomeRedirector() {
  const router = useRouter();
  const search = useSearchParams();

  useEffect(() => {
    const callbackUrl = search.get("callbackUrl");
    router.replace(
      pickHomeRoute(
        useActiveConnectionStore.getState(),
        callbackUrl,
        window.location.origin,
      ),
    );
  }, [router, search]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="text-xs text-muted-foreground">正在跳转…</p>
    </div>
  );
}
