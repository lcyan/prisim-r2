// tests/unit/features/buckets-page.test.tsx
//
// Sanity-check the /buckets index page across its four states:
// no-connection, empty list, populated grid, and error. The hook
// (useBuckets) and the active-connection selector are both mocked so
// this test exercises only render logic.

import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-buckets", () => ({ useBuckets: vi.fn() }));
vi.mock("@/stores/active-connection", () => ({
  useActiveConnectionStore: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/buckets",
  useRouter: () => ({ push: vi.fn() }),
}));

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import BucketsPage from "@/app/(dashboard)/buckets/page";

// The page consumes the store via selector — `useStore((s) => s.x)`. A bare
// `mockReturnValue({ activeConnectionId: null })` would skip the selector
// and return the *state object* (truthy) instead of the id. Resolve via
// mockImplementation so the selector actually runs.
function setActiveConnection(state: { activeConnectionId: string | null }) {
  vi.mocked(useActiveConnectionStore).mockImplementation(
    ((selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state) as never,
  );
}

function withQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("BucketsPage", () => {
  it("shows empty state when no buckets", () => {
    setActiveConnection({ activeConnectionId: "01" });
    vi.mocked(useBuckets).mockReturnValue({
      data: [],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getByText(/暂无 Bucket/)).toBeInTheDocument();
  });

  it("renders one card per bucket", () => {
    setActiveConnection({ activeConnectionId: "01" });
    vi.mocked(useBuckets).mockReturnValue({
      data: [
        { name: "assets", createdAt: Date.now() },
        { name: "backups", createdAt: Date.now() },
        { name: "logs", createdAt: null },
      ],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<BucketsPage />));
    expect(
      screen.getAllByRole("link", { name: /assets|backups|logs/ }),
    ).toHaveLength(3);
  });

  it("shows error state with retry", () => {
    setActiveConnection({ activeConnectionId: "01" });
    vi.mocked(useBuckets).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("Boom"),
      refetch: vi.fn(),
    } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getByText(/无法加载/)).toBeInTheDocument();
  });

  it("prompts for connection when none active", () => {
    setActiveConnection({ activeConnectionId: null });
    vi.mocked(useBuckets).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getByText(/请先在顶栏选择一个连接/)).toBeInTheDocument();
  });
});
