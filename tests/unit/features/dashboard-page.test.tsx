import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-dashboard", () => ({ useDashboardSummary: vi.fn() }));
vi.mock("@/stores/active-connection", () => ({
  useActiveConnectionStore: vi.fn(),
}));
vi.mock("@/components/features/dashboard/ops-by-day-bar", () => ({
  OpsByDayBar: () => <div data-testid="ops-by-day-bar" />,
}));
vi.mock("@/components/features/dashboard/ops-by-type-bar", () => ({
  OpsByTypeBar: () => <div data-testid="ops-by-type-bar" />,
}));
vi.mock("@/components/features/dashboard/recent-activity", () => ({
  RecentActivity: () => <div data-testid="recent-activity" />,
}));

import { useDashboardSummary } from "@/hooks/use-dashboard";
import { useActiveConnectionStore } from "@/stores/active-connection";
import DashboardPage from "@/app/(dashboard)/dashboard/page";

function setActiveConnection(state: { activeConnectionId: string | null }) {
  vi.mocked(useActiveConnectionStore).mockImplementation((
    (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state
  ) as never);
}

function setDashboardSummary() {
  vi.mocked(useDashboardSummary).mockReturnValue({
    data: {
      bucketsCount: 2,
      shares: { active: 1, expiring7d: 0 },
      ops: { count: 9, previousCount: 3 },
      failures: { count: 0, ratePct: 0 },
      opsByDay: [],
      opsByType: [],
      recentActivity: [],
      totp: { recoveryCodesRemaining: 10 },
    },
    isPending: false,
    isError: false,
  } as never);
}

describe("DashboardPage", () => {
  it("uses the 7 day dashboard range without rendering a range toggle", () => {
    setActiveConnection({ activeConnectionId: "conn-1" });
    setDashboardSummary();

    render(<DashboardPage />);

    expect(useDashboardSummary).toHaveBeenCalledWith("conn-1", "7d");
    expect(screen.queryByRole("tablist", { name: "时间范围" })).toBeNull();
    expect(screen.getByText("7 天操作")).toBeInTheDocument();
    expect(screen.getByText("7 天失败率")).toBeInTheDocument();
    expect(screen.getByText("操作量 · 7 天")).toBeInTheDocument();
    expect(screen.queryByText("30 天操作")).toBeNull();
    expect(screen.queryByText("操作量 · 30 天")).toBeNull();
  });
});
