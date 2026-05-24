"use client";

// components/layout/app-shell.tsx
//
// 仪表盘外层布局。基于 shadcn sidebar-07 风格:
//   <SidebarProvider>
//     <AppSidebar />
//     <SidebarInset>
//       <AppTopbar />
//       <main>{children}</main>
//     </SidebarInset>
//     <CommandMenu />
//   </SidebarProvider>
//
// SidebarProvider 自带:展开/折叠 cookie 持久化、移动端 Sheet、键盘
// 快捷键 (默认 `[` 切换)。

import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { CommandMenu } from "@/components/layout/command-menu";

interface AppShellProps {
  children: ReactNode;
  user: { email: string };
}

export function AppShell({ children, user }: AppShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppTopbar user={user} />
        <main className="flex-1 min-w-0 overflow-auto">{children}</main>
      </SidebarInset>
      <CommandMenu />
    </SidebarProvider>
  );
}
