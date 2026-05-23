// components/features/dashboard/pick-home-route.ts
//
// Pure routing decision for the home page bouncer.
//
// Sub-spec 1: dashboard-first. /dashboard is the safe landing page that
// every authenticated user can reach regardless of whether they have a
// connection or a bucket selected. Sub-spec 2 will replace the placeholder
// dashboard with the real overview.
//
// callbackUrl support: if a relative path is supplied (e.g. middleware
// redirected the user mid-navigation), honor it. Reject any URL that
// isn't a same-origin relative path to prevent open-redirect.

export function pickHomeRoute(
  state: {
    activeConnectionId: string | null;
    activeBucket: string | null;
  },
  callbackUrl?: string | null,
): string {
  if (callbackUrl && isSafeRelative(callbackUrl)) {
    return callbackUrl;
  }
  return "/dashboard";
}

function isSafeRelative(url: string): boolean {
  if (!url.startsWith("/")) return false;
  // 防 //evil/path 形式的协议相对 URL
  if (url.startsWith("//")) return false;
  return true;
}
