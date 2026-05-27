"use client";

// components/layout/app-sidebar.tsx
//
// flat 主导航 + 设置分组。bucket 二级菜单与活动连接卡都已移除,
// connection / bucket 的切换由顶栏面包屑承担。

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  FileClock,
  LayoutDashboard,
  Link2,
  Plug,
  Settings,
} from "lucide-react";

import { PrismMark } from "@/components/brand/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const T = {
  brand: "Prisim R2",
  brandSub: "Cloudflare R2 控制台",
  groupMain: "主导航",
  groupAdmin: "设置",
  navDashboard: "仪表盘",
  navBuckets: "存储桶",
  navShares: "分享链接",
  navAudit: "审计日志",
  navConnections: "连接管理",
  navSettings: "设置",
} as const;

type NavItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
  matchPrefixes: string[];
};

const MAIN_NAV: readonly NavItem[] = [
  {
    label: T.navDashboard,
    href: "/dashboard",
    icon: LayoutDashboard,
    matchPrefixes: ["/dashboard"],
  },
  {
    label: T.navBuckets,
    href: "/buckets",
    icon: Database,
    matchPrefixes: ["/buckets"],
  },
  {
    label: T.navShares,
    href: "/shares",
    icon: Link2,
    matchPrefixes: ["/shares"],
  },
  {
    label: T.navAudit,
    href: "/audit",
    icon: FileClock,
    matchPrefixes: ["/audit"],
  },
];

const ADMIN_NAV: readonly NavItem[] = [
  {
    label: T.navConnections,
    href: "/connections",
    icon: Plug,
    matchPrefixes: ["/connections", "/settings/connections"],
  },
  {
    label: T.navSettings,
    href: "/settings",
    icon: Settings,
    matchPrefixes: ["/settings"],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  return item.matchPrefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function AppSidebar() {
  const pathname = usePathname() ?? "";
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <PrismMark size={28} className="shrink-0" />
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold">{T.brand}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {T.brandSub}
            </p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{T.groupMain}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN_NAV.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  active={isActive(pathname, item)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{T.groupAdmin}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {ADMIN_NAV.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  active={isActive(pathname, item)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link href={item.href} data-active={active}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
