"use client";

// components/providers/mode-provider.tsx
//
// 把 useUiStore.mode (light/dark/system) 解析成实际生效的 light/dark,
// 并写到 <html data-mode="...">。监听 prefers-color-scheme 变化使
// "system" 模式可以实时跟随。
//
// 与 next-themes 完全解耦:主色由 next-themes 写 data-theme,模式
// 由本组件写 data-mode,两者互不覆盖。

import { useEffect, type ReactNode } from "react";
import { useUiStore } from "@/stores/ui-store";

function resolveEffectiveMode(mode: "light" | "dark" | "system"): "light" | "dark" {
  if (mode === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const mode = useUiStore((s) => s.mode);

  useEffect(() => {
    const apply = () => {
      const effective = resolveEffectiveMode(mode);
      document.documentElement.setAttribute("data-mode", effective);
    };
    apply();
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);

  return <>{children}</>;
}
