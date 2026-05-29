import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/use-buckets", () => ({ useBuckets: vi.fn() }));
vi.mock("@/stores/active-connection", () => ({
  useActiveConnectionStore: vi.fn(),
}));

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { TopbarBucketPopover } from "@/components/layout/topbar-bucket-popover";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("TopbarBucketPopover", () => {
  it("shows current bucket name", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: "01ABC",
      activeBucket: "assets",
    } as never);
    vi.mocked(useBuckets).mockReturnValue({
      data: [
        { name: "assets", createdAt: 0 },
        { name: "backups", createdAt: 0 },
      ],
      isPending: false,
    } as never);
    render(withQuery(<TopbarBucketPopover currentBucket="assets" />));
    expect(screen.getByRole("button", { name: /assets/ })).toBeInTheDocument();
  });

  it("links to the current bucket root even when the bucket list is empty", async () => {
    const user = userEvent.setup();
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: "01ABC",
      activeBucket: "my bucket",
    } as never);
    vi.mocked(useBuckets).mockReturnValue({
      data: [],
      isPending: false,
    } as never);

    render(withQuery(<TopbarBucketPopover currentBucket="my bucket" />));

    await user.click(screen.getByRole("button", { name: /my bucket/ }));

    expect(
      screen.getByRole("link", { name: "打开 Bucket 根目录" }),
    ).toHaveAttribute("href", "/buckets/my%20bucket");
  });
});
