import { describe, expect, it } from "vitest";

import { pickHomeRoute } from "@/components/features/dashboard/pick-home-route";

describe("pickHomeRoute", () => {
  it("returns /dashboard when no callbackUrl is supplied", () => {
    expect(pickHomeRoute({ activeConnectionId: null, activeBucket: null })).toBe(
      "/dashboard",
    );
    expect(
      pickHomeRoute({ activeConnectionId: "conn_01", activeBucket: null }),
    ).toBe("/dashboard");
    expect(
      pickHomeRoute({ activeConnectionId: "conn_01", activeBucket: "dev" }),
    ).toBe("/dashboard");
  });

  it("respects a callbackUrl when provided", () => {
    expect(
      pickHomeRoute(
        { activeConnectionId: "conn_01", activeBucket: "dev" },
        "/buckets/dev/sub",
      ),
    ).toBe("/buckets/dev/sub");
  });

  it("rejects external callbackUrls (open-redirect guard)", () => {
    expect(
      pickHomeRoute(
        { activeConnectionId: null, activeBucket: null },
        "https://evil.example/",
      ),
    ).toBe("/dashboard");
    expect(
      pickHomeRoute(
        { activeConnectionId: null, activeBucket: null },
        "//evil.example/x",
      ),
    ).toBe("/dashboard");
  });

  it("rejects callbackUrls that do not start with /", () => {
    expect(
      pickHomeRoute({ activeConnectionId: null, activeBucket: null }, "javascript:alert(1)"),
    ).toBe("/dashboard");
  });
});
