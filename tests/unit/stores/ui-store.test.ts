import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "@/stores/ui-store";

describe("useUiStore — commandMenu", () => {
  beforeEach(() => {
    useUiStore.setState({ commandMenuOpen: false, mode: "system" });
  });

  it("opens command menu", () => {
    useUiStore.getState().openCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(true);
  });

  it("closes command menu", () => {
    useUiStore.setState({ commandMenuOpen: true });
    useUiStore.getState().closeCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(false);
  });

  it("toggles command menu", () => {
    useUiStore.getState().toggleCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(true);
    useUiStore.getState().toggleCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(false);
  });
});

describe("useUiStore — mode", () => {
  beforeEach(() => {
    useUiStore.setState({ commandMenuOpen: false, mode: "system" });
  });

  it("default mode is 'system'", () => {
    expect(useUiStore.getState().mode).toBe("system");
  });

  it("setMode persists", () => {
    useUiStore.getState().setMode("dark");
    expect(useUiStore.getState().mode).toBe("dark");
  });
});
