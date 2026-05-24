"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TopbarBreadcrumb } from "@/components/layout/topbar-breadcrumb";
import { CommandMenuTrigger } from "@/components/layout/command-menu-trigger";
import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";
import { UserMenu } from "@/components/features/dashboard/user-menu";

interface AppTopbarProps {
  user: { email: string };
}

export function AppTopbar({ user }: AppTopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-5" />
      <div className="flex-1 min-w-0">
        <TopbarBreadcrumb />
      </div>
      <CommandMenuTrigger />
      <ThemeSwitcher />
      <UserMenu email={user.email} />
    </header>
  );
}
