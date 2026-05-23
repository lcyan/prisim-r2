import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next-themes 的 useTheme hook 在测试环境下不能正常工作（没有 Provider），
// 在测试入口 mock 掉。
const setTheme = vi.fn();
let currentTheme = "blue";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: currentTheme, setTheme }),
}));

import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    setTheme.mockClear();
    currentTheme = "blue";
  });

  it("renders the trigger with the current theme label", () => {
    render(<ThemeSwitcher />);
    expect(screen.getByText("经典蓝")).toBeInTheDocument();
  });

  it("opens popover and lists all three themes when clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    // "经典蓝" 同时出现在 trigger 上（current theme label）和 popover item 里 —
    // 用 getAllByText 接受多个匹配；活力橙/清新绿 只在 popover 里出现。
    expect(screen.getAllByText("经典蓝").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("活力橙")).toBeInTheDocument();
    expect(screen.getByText("清新绿")).toBeInTheDocument();
  });

  it("calls setTheme('orange') when the orange row is clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    await user.click(screen.getByText("活力橙"));
    expect(setTheme).toHaveBeenCalledWith("orange");
  });
});
