import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MemoryRouterProvider } from "@/tests/stubs/memory-router";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";

function renderSidebar(pathname: string) {
  return render(
    <MemoryRouterProvider pathname={pathname}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouterProvider>,
  );
}

describe("AppSidebar", () => {
  it("renders all 6 nav items with Chinese labels", () => {
    renderSidebar("/dashboard");
    for (const label of [
      "仪表盘",
      "存储桶",
      "分享链接",
      "审计日志",
      "连接管理",
      "设置",
    ]) {
      expect(
        screen.getByRole("link", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }
  });

  it("marks current route as active", () => {
    renderSidebar("/audit");
    const link = screen.getByRole("link", { name: /审计日志/ });
    expect(link).toHaveAttribute("data-active", "true");
  });

  it("active state uses prefix matching for nested routes", () => {
    renderSidebar("/buckets/my-bucket/foo/");
    const link = screen.getByRole("link", { name: /存储桶/ });
    expect(link).toHaveAttribute("data-active", "true");
  });

  it("renders brand header", () => {
    renderSidebar("/dashboard");
    expect(screen.getByText("Prisim R2")).toBeInTheDocument();
  });
});
