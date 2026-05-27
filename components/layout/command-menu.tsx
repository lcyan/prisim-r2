"use client";

// components/layout/command-menu.tsx
//
// ⌘K command menu. Renders two groups:
//   - 导航  · 6 静态目的地
//   - 快捷动作  · 新建连接 + 切主色 (蓝/橙/绿) + 切模式 (亮/暗/系统)
//
// 键盘绑定在 useEffect 全局监听;按 ⌘K (macOS) / ctrl+K (其他) 触发。

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";

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
  groupActions: "快捷动作",
  pickBlue: "切换主题 · 经典蓝",
  pickOrange: "切换主题 · 活力橙",
  pickGreen: "切换主题 · 清新绿",
  pickLight: "切换到亮色",
  pickDark: "切换到暗色",
  pickSystem: "跟随系统",
  newConnection: "新建连接",
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
  const { setTheme } = useTheme();
  const setMode = useUiStore((s) => s.setMode);

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
        <CommandGroup heading={T.groupActions}>
          <CommandItem onSelect={run(() => router.push("/connections?new=1"))}>
            {T.newConnection}
          </CommandItem>
          <CommandItem onSelect={run(() => setTheme("blue"))}>
            {T.pickBlue}
          </CommandItem>
          <CommandItem onSelect={run(() => setTheme("orange"))}>
            {T.pickOrange}
          </CommandItem>
          <CommandItem onSelect={run(() => setTheme("green"))}>
            {T.pickGreen}
          </CommandItem>
          <CommandItem onSelect={run(() => setMode("light"))}>
            {T.pickLight}
          </CommandItem>
          <CommandItem onSelect={run(() => setMode("dark"))}>
            {T.pickDark}
          </CommandItem>
          <CommandItem onSelect={run(() => setMode("system"))}>
            {T.pickSystem}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
