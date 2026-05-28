// components/features/dashboard/pick-home-route.ts
//
// Pure routing decision for the home page bouncer.
//
// Sub-spec 1: dashboard-first. /dashboard is the safe landing page that
// every authenticated user can reach regardless of whether they have a
// connection or a bucket selected. Sub-spec 2 will replace the placeholder
// dashboard with the real overview.
//
// callbackUrl support: if a same-origin app path is supplied (e.g. middleware
// redirected the user mid-navigation), honor it. Reject auth pages and
// external URLs so the post-login flow cannot bounce back to /login.

import { pickPostLoginRoute } from "@/lib/auth/redirect";

export function pickHomeRoute(
  state: {
    activeConnectionId: string | null;
    activeBucket: string | null;
  },
  callbackUrl?: string | null,
  origin?: string,
): string {
  void state;
  return pickPostLoginRoute(callbackUrl, { origin });
}
