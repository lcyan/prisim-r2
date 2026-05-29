import { render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

import { TopbarBreadcrumb } from "@/components/layout/topbar-breadcrumb";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("@/components/layout/topbar-connection-popover", () => ({
  TopbarConnectionPopover: () => <button type="button">连接</button>,
}));

vi.mock("@/components/layout/topbar-bucket-popover", () => ({
  TopbarBucketPopover: ({ currentBucket }: { currentBucket: string }) => (
    <a href={`/buckets/${encodeURIComponent(currentBucket)}`}>{currentBucket}</a>
  ),
}));

const mockedUsePathname = vi.mocked(usePathname);

describe("TopbarBreadcrumb", () => {
  it("renders clickable parent prefixes and a non-clickable current prefix", () => {
    mockedUsePathname.mockReturnValue("/buckets/image-bed-pro/auto/2026/05");

    render(<TopbarBreadcrumb />);

    const nav = screen.getByRole("navigation", { name: "面包屑" });

    expect(
      within(nav).getByRole("link", { name: "image-bed-pro" }),
    ).toHaveAttribute("href", "/buckets/image-bed-pro");
    expect(within(nav).getByRole("link", { name: "auto" })).toHaveAttribute(
      "href",
      "/buckets/image-bed-pro/auto",
    );
    expect(within(nav).getByRole("link", { name: "2026" })).toHaveAttribute(
      "href",
      "/buckets/image-bed-pro/auto/2026",
    );

    expect(within(nav).getByText("05/")).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "05" })).toBeNull();
  });
});
