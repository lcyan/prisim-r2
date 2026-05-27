"use client";

// components/features/dashboard/user-menu.tsx
//
// 顶栏右侧用户菜单。点击展开 popover，内容：邮箱（只读）+ 退出登录。
// 偏离设计稿原版的"点击立即退出" —— 避免误点，详见 spec §4.3。

import { signOut } from "next-auth/react";
import { LogOut, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const T = {
  ariaLabel: "用户菜单",
  signOut: "退出登录",
} as const;

interface UserMenuProps {
  email: string;
}

export function UserMenu({ email }: UserMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={T.ariaLabel}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md border border-transparent bg-transparent px-2 text-sm",
            "transition-colors hover:bg-accent",
          )}
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
            {email[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
            {email}
          </span>
          <ChevronDown
            className="h-3 w-3 text-muted-foreground"
            strokeWidth={2}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2"
        >
          <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span>{T.signOut}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
