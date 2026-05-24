import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-themes", () => {
  let theme = "blue";
  return {
    useTheme: () => ({
      theme,
      setTheme: (t: string) => {
        theme = t;
      },
    }),
  };
});

import { useUiStore } from "@/stores/ui-store";
import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";

describe("ThemeSwitcher dual axis", () => {
  beforeEach(() => {
    useUiStore.setState({ mode: "system", commandMenuOpen: false });
  });

  it("primary color picker and mode picker both render", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    expect(screen.getByText("主色")).toBeInTheDocument();
    expect(screen.getByText("外观")).toBeInTheDocument();
  });

  it("clicking 暗色 updates ui-store", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    await user.click(screen.getByText("暗色"));
    expect(useUiStore.getState().mode).toBe("dark");
  });
});
