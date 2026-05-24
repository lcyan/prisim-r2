import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-connections", () => ({
  useConnections: vi.fn(),
}));
vi.mock("@/stores/active-connection", () => ({
  useActiveConnectionStore: vi.fn(),
}));

import { useConnections } from "@/hooks/use-connections";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { TopbarConnectionPopover } from "@/components/layout/topbar-connection-popover";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("TopbarConnectionPopover", () => {
  beforeEach(() => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: "01ABC",
      setActiveConnectionId: vi.fn(),
      clearActiveConnectionId: vi.fn(),
    });
  });

  it("renders active connection name as trigger", () => {
    vi.mocked(useConnections).mockReturnValue({
      data: [
        { id: "01ABC", name: "prod-main", accountId: "x", accessKeyMasked: "y", createdAt: 0, lastUsedAt: null },
      ],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<TopbarConnectionPopover />));
    expect(screen.getByRole("button", { name: /prod-main/ })).toBeInTheDocument();
  });

  it("shows placeholder when no connection selected", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: null,
      setActiveConnectionId: vi.fn(),
      clearActiveConnectionId: vi.fn(),
    });
    vi.mocked(useConnections).mockReturnValue({ data: [], isPending: false, isError: false } as never);
    render(withQuery(<TopbarConnectionPopover />));
    expect(screen.getByRole("button", { name: /选择连接/ })).toBeInTheDocument();
  });

  it("opens popover with all connections + new-connection link on click", async () => {
    const user = userEvent.setup();
    vi.mocked(useConnections).mockReturnValue({
      data: [
        { id: "01ABC", name: "prod-main", accountId: "x", accessKeyMasked: "y", createdAt: 0, lastUsedAt: null },
        { id: "02DEF", name: "staging", accountId: "x", accessKeyMasked: "y", createdAt: 0, lastUsedAt: null },
      ],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<TopbarConnectionPopover />));
    await user.click(screen.getByRole("button", { name: /prod-main/ }));
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /新建连接/ })).toBeInTheDocument();
  });
});
