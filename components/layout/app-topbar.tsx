"use client";

// components/layout/app-topbar.tsx
//
// 顶栏外壳。Phase 1 版本:仅 SidebarTrigger + 占位面包屑 + 主题/用户菜单。
// Phase 2 将把占位面包屑替换为路由感知的 <TopbarBreadcrumb />。

import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";
import { UserMenu } from "@/components/features/dashboard/user-menu";

interface AppTopbarProps {
  user: { email: string };
}

export function AppTopbar({ user }: AppTopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-5" />
      <div className="flex-1 min-w-0">
        {/* Phase 2 替换为面包屑 */}
        <span className="text-sm text-muted-foreground">Prisim R2</span>
      </div>
      <ThemeSwitcher />
      <UserMenu email={user.email} />
    </header>
  );
}
