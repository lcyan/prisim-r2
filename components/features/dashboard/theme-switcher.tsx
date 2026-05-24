"use client";

// components/features/dashboard/theme-switcher.tsx
//
// 双维主题切换:
//   - 主色:blue / orange / green   (写 data-theme,next-themes 管)
//   - 外观:light / dark / system  (写 data-mode,ModeProvider + useUiStore 管)

import { Check, Palette } from "lucide-react";
import { useTheme } from "next-themes";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUiStore, type Mode } from "@/stores/ui-store";
import { cn } from "@/lib/utils";

const T = {
  ariaLabel: "切换主题",
  groupPrimary: "主色",
  groupMode: "外观",
  themeBlue: "经典蓝",
  themeOrange: "活力橙",
  themeGreen: "清新绿",
  modeLight: "亮色",
  modeDark: "暗色",
  modeSystem: "跟随系统",
} as const;

const PRIMARIES: Array<{ value: "blue" | "orange" | "green"; label: string }> = [
  { value: "blue", label: T.themeBlue },
  { value: "orange", label: T.themeOrange },
  { value: "green", label: T.themeGreen },
];

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "light", label: T.modeLight },
  { value: "dark", label: T.modeDark },
  { value: "system", label: T.modeSystem },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const mode = useUiStore((s) => s.mode);
  const setMode = useUiStore((s) => s.setMode);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={T.ariaLabel}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card transition-colors hover:bg-accent"
      >
        <Palette className="h-4 w-4" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel>{T.groupPrimary}</DropdownMenuLabel>
        {PRIMARIES.map((p) => (
          <DropdownMenuItem
            key={p.value}
            onSelect={() => setTheme(p.value)}
            className="flex items-center justify-between"
          >
            <span className={cn(p.value === theme && "font-medium")}>{p.label}</span>
            {p.value === theme ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{T.groupMode}</DropdownMenuLabel>
        {MODES.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onSelect={() => setMode(m.value)}
            className="flex items-center justify-between"
          >
            <span className={cn(m.value === mode && "font-medium")}>{m.label}</span>
            {m.value === mode ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
