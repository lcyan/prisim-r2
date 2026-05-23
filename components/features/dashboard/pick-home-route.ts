// components/features/dashboard/pick-home-route.ts
//
// Pure routing decision for the home page bouncer. Lives in its own module
// (no React, no next/navigation imports) so the rule can be unit-tested
// from the node-env Vitest suite without dragging in a JSX/jsdom setup.
//
// Rule: a bucket route only makes sense when BOTH a connection AND a bucket
// are persisted. A connection without a bucket goes to /settings/connections
// so the user can pick one — the bucket switcher in the header would
// otherwise sit empty while the main pane shows nothing actionable.

export function pickHomeRoute(state: {
  activeConnectionId: string | null;
  activeBucket: string | null;
}): string {
  if (state.activeConnectionId && state.activeBucket) {
    return `/buckets/${encodeURIComponent(state.activeBucket)}`;
  }
  return "/settings/connections";
}
