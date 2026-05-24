"use client";

// components/features/dashboard/theme-switcher.tsx
//
// 顶栏右侧主题切换 pill。点击展开 popover，列三主题，点击立即应用并持久化。
// 状态由 next-themes 管理（attribute="data-theme"，storageKey="prisim-r2-theme"）。

import { useTheme } from "next-themes";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type ThemeName = "blue" | "orange" | "green";

const T = {
  ariaLabel: "切换主题",
  popoverTitle: "亮色主题",
} as const;

const THEMES: Array<{
  id: ThemeName;
  name: string;
  primary: string;
  soft: string;
  bg: string;
  meta: string;
}> = [
  {
    id: "blue",
    name: "经典蓝",
    primary: "#1677FF",
    soft: "#F0F5FF",
    bg: "#FFFFFF",
    meta: "#1677FF · #F0F5FF",
  },
  {
    id: "orange",
    name: "活力橙",
    primary: "#FF6A00",
    soft: "#FFF7ED",
    bg: "#FFFBF5",
    meta: "#FF6A00 · #FFF7ED",
  },
  {
    id: "green",
    name: "清新绿",
    primary: "#00B96B",
    soft: "#ECFDF5",
    bg: "#F6FEFA",
    meta: "#00B96B · #ECFDF5",
  },
];

function asThemeName(t: string | undefined): ThemeName {
  if (t === "orange" || t === "green") return t;
  return "blue";
}

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const current = THEMES.find((x) => x.id === asThemeName(theme)) ?? THEMES[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={T.ariaLabel}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm",
            "transition-colors hover:border-foreground/30",
          )}
        >
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ background: current.primary }}
            aria-hidden
          />
          <span className="font-medium">{current.name}</span>
          <ChevronDown
            className="h-3 w-3 text-muted-foreground"
            strokeWidth={2}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {T.popoverTitle}
        </DropdownMenuLabel>
        {THEMES.map((t) => {
          const active = t.id === current.id;
          return (
            <DropdownMenuItem
              key={t.id}
              onSelect={() => setTheme(t.id)}
              className="flex items-center gap-3 py-2"
            >
              <div className="flex shrink-0 items-center gap-0.5">
                <span
                  className="h-4 w-4 rounded-sm"
                  style={{ background: t.primary }}
                />
                <span
                  className="h-4 w-4 rounded-sm border border-border/50"
                  style={{ background: t.soft }}
                />
                <span
                  className="h-4 w-4 rounded-sm border border-border/50"
                  style={{ background: t.bg }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{t.name}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {t.meta}
                </div>
              </div>
              {active ? (
                <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
              ) : (
                <span className="w-3.5" aria-hidden />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
