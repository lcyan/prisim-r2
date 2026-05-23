// tests/unit/dashboard/home-redirector.test.ts
//
// Covers the pure routing decision for the home page bouncer. The component
// itself (useEffect + useRouter) is too thin to be worth a jsdom setup, but
// the rule "respect the persisted activeBucket" is exactly what the original
// bug reported, so it gets its own pinned test.

import { describe, expect, it } from "vitest";

import { pickHomeRoute } from "@/components/features/dashboard/pick-home-route";

describe("pickHomeRoute", () => {
  it("falls back to /settings/connections when nothing is persisted", () => {
    expect(
      pickHomeRoute({ activeConnectionId: null, activeBucket: null }),
    ).toBe("/settings/connections");
  });

  it("falls back to /settings/connections when only a connection is set", () => {
    // A connection without a bucket means the user hasn't picked one yet —
    // landing on /buckets/null would be nonsense, and we want them to see
    // the bucket switcher's "no bucket selected" affordance instead.
    expect(
      pickHomeRoute({
        activeConnectionId: "01HXYZ",
        activeBucket: null,
      }),
    ).toBe("/settings/connections");
  });

  it("falls back to /settings/connections when only a bucket is set", () => {
    // A bucket name without a connection is leftover state from a deleted
    // connection — the bucket browser would have nothing to fetch.
    expect(
      pickHomeRoute({
        activeConnectionId: null,
        activeBucket: "dev",
      }),
    ).toBe("/settings/connections");
  });

  it("routes to /buckets/<bucket> when both slots are populated", () => {
    expect(
      pickHomeRoute({
        activeConnectionId: "01HXYZ",
        activeBucket: "dev",
      }),
    ).toBe("/buckets/dev");
  });

  it("URL-encodes the bucket segment so '.' / '-' survive but unusual bytes are escaped", () => {
    // R2 BucketNameSchema constrains to [a-z0-9.-], so '.' and '-' are
    // typical. encodeURIComponent leaves both alone — assert that, and
    // also assert that a hypothetical loosening of the schema (or stale
    // localStorage carrying a name written by another tool) doesn't
    // produce an unencoded segment.
    expect(
      pickHomeRoute({
        activeConnectionId: "01HXYZ",
        activeBucket: "my-bucket.v2",
      }),
    ).toBe("/buckets/my-bucket.v2");
    expect(
      pickHomeRoute({
        activeConnectionId: "01HXYZ",
        activeBucket: "needs encoding",
      }),
    ).toBe("/buckets/needs%20encoding");
  });
});
