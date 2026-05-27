"use client";

// components/layout/command-menu-trigger.tsx
//
// 顶栏右侧的 "搜索 · ⌘K" 胶囊。点击或键盘 ⌘K 触发 CommandMenu。
// 键盘绑定本身在 <CommandMenu /> 内部全局监听;本组件只做点击入口
// + 视觉提示。

import { Search } from "lucide-react";
import { useUiStore } from "@/stores/ui-store";

const T = { trigger: "搜索" } as const;

export function CommandMenuTrigger() {
  const open = useUiStore((s) => s.openCommandMenu);
  return (
    <button
      type="button"
      onClick={open}
      className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground md:flex"
      aria-label="打开命令面板"
    >
      <Search className="h-3 w-3" strokeWidth={1.75} />
      <span>{T.trigger}</span>
      <span className="ml-2 rounded border border-border px-1.5 font-mono text-[10px] tracking-tight">
        ⌘K
      </span>
    </button>
  );
}
