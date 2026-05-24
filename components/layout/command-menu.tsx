"use client";

// components/layout/command-menu.tsx
//
// Phase 1 占位:支持 ⌘K 触发与 6 项静态导航。Phase 2 加 bucket / connection
// 动态加载,Phase 3 加 "切主题 / 切模式" 快捷动作。

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useUiStore } from "@/stores/ui-store";

const T = {
  placeholder: "搜索或跳转…",
  empty: "没有匹配项",
  groupNav: "导航",
  navDashboard: "仪表盘",
  navBuckets: "存储桶",
  navShares: "分享链接",
  navAudit: "审计日志",
  navConnections: "连接管理",
  navSettings: "设置",
} as const;

const NAV = [
  { label: T.navDashboard, href: "/dashboard" },
  { label: T.navBuckets, href: "/buckets" },
  { label: T.navShares, href: "/shares" },
  { label: T.navAudit, href: "/audit" },
  { label: T.navConnections, href: "/connections" },
  { label: T.navSettings, href: "/settings" },
] as const;

export function CommandMenu() {
  const router = useRouter();
  const open = useUiStore((s) => s.commandMenuOpen);
  const close = useUiStore((s) => s.closeCommandMenu);
  const toggle = useUiStore((s) => s.toggleCommandMenu);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  function run(action: () => void) {
    return () => {
      close();
      action();
    };
  }

  return (
    <CommandDialog open={open} onOpenChange={(o) => (o ? null : close())}>
      <CommandInput placeholder={T.placeholder} />
      <CommandList>
        <CommandEmpty>{T.empty}</CommandEmpty>
        <CommandGroup heading={T.groupNav}>
          {NAV.map((item) => (
            <CommandItem
              key={item.href}
              onSelect={run(() => router.push(item.href))}
            >
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
