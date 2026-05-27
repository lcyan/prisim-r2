// stores/ui-store.ts
//
// UI 状态(非业务数据)。两条独立的"游标":
//   - commandMenuOpen: ⌘K 弹窗开关
//   - mode: 暗色模式偏好(localStorage 持久化)
//
// 主色(blue/orange/green)仍由 next-themes 管理(see components/providers.tsx),
// 不进入这个 store。

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Mode = "light" | "dark" | "system";

interface UiState {
  commandMenuOpen: boolean;
  openCommandMenu: () => void;
  closeCommandMenu: () => void;
  toggleCommandMenu: () => void;

  mode: Mode;
  setMode: (mode: Mode) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      commandMenuOpen: false,
      openCommandMenu: () => set({ commandMenuOpen: true }),
      closeCommandMenu: () => set({ commandMenuOpen: false }),
      toggleCommandMenu: () =>
        set((s) => ({ commandMenuOpen: !s.commandMenuOpen })),

      mode: "system",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "prisim-ui",
      storage: createJSONStorage(() => localStorage),
      // 命令面板开关属于"瞬时 UI",不持久化;只持久化 mode。
      partialize: (s) => ({ mode: s.mode }),
    },
  ),
);
