"use client";

// components/layout/app-shell.tsx
//
// 仪表盘外层布局：232px 侧栏 + 56px 顶栏 + 内容区。
// 顶栏左侧 Bucket 切换器，右侧主题切换器 + 用户菜单。
// 侧栏顶部 logo，6 项主导航，"存储桶"下常驻展开 bucket 二级，底部活动连接卡。

import { type ReactNode } from "react";
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

import { useActiveConnectionStore } from "@/stores/active-connection";
import { useConnections } from "@/hooks/use-connections";
import { useBuckets } from "@/hooks/use-buckets";
import { BucketSwitcher } from "@/components/features/dashboard/bucket-switcher";
import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";
import { UserMenu } from "@/components/features/dashboard/user-menu";
import { cn } from "@/lib/utils";

const T = {
  brand: "Prisim R2",
  brandSub: "Cloudflare R2 管理控制台",
  navDashboard: "仪表盘",
  navBuckets: "存储桶",
  navShares: "分享链接",
  navAudit: "审计日志",
  navConnections: "连接管理",
  navSettings: "设置",
  activeConnLabel: "活动连接",
  noConn: "未选择连接",
} as const;

interface AppShellProps {
  children: ReactNode;
  user: { email: string };
}

type NavItem = {
  label: string;
  href: string;
  icon: typeof Database;
  matchPrefixes: string[];
};

const NAV_ITEMS: NavItem[] = [
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

export function AppShell({ children, user }: AppShellProps) {
  return (
    <div
      className="grid h-screen w-screen overflow-hidden bg-background text-foreground"
      style={{
        gridTemplate:
          '"sidebar topbar" var(--topbar-h) "sidebar main" 1fr / var(--sidebar-w) 1fr',
      }}
    >
      <Sidebar />
      <TopBar user={user} />
      <main className="min-w-0 overflow-auto" style={{ gridArea: "main" }}>
        {children}
      </main>
    </div>
  );
}

/* ────────────────────────── 顶栏 ────────────────────────── */

function TopBar({ user }: { user: { email: string } }) {
  return (
    <header
      className="flex items-center justify-between border-b border-border bg-background px-4"
      style={{ gridArea: "topbar" }}
    >
      <div className="flex items-center gap-4">
        <BucketSwitcher />
      </div>
      <div className="flex items-center gap-3">
        <ThemeSwitcher />
        <UserMenu email={user.email} />
      </div>
    </header>
  );
}

/* ────────────────────────── 侧栏 ────────────────────────── */

function Sidebar() {
  const pathname = usePathname() ?? "";
  const { activeConnectionId, activeBucket } = useActiveConnectionStore();
  const { data: connections } = useConnections();
  const { data: buckets } = useBuckets(activeConnectionId);

  const activeConn =
    connections?.find((c) => c.id === activeConnectionId) ?? null;

  return (
    <aside
      className="flex flex-col border-r border-border"
      style={{ gridArea: "sidebar", background: "var(--sidebar-bg)" }}
    >
      {/* Brand */}
      <div className="border-b border-border px-4 py-4">
        <p className="text-base font-semibold tracking-tight">{T.brand}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {T.brandSub}
        </p>
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-px overflow-y-auto px-2 pt-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.matchPrefixes.some((p) =>
            pathname.startsWith(p),
          );
          return (
            <div key={item.href}>
              <Link
                href={item.href}
                data-active={isActive}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                  isActive
                    ? "signal-bar font-medium"
                    : "hover:bg-accent/60 hover:text-foreground",
                )}
                style={
                  isActive
                    ? {
                        color: "var(--primary)",
                        background: "var(--primary-soft)",
                      }
                    : { color: "var(--fg-2)" }
                }
              >
                <Icon className="h-4 w-4" strokeWidth={1.75} />
                <span className="flex-1 text-left">{item.label}</span>
              </Link>

              {/* 存储桶二级 bucket 列表 */}
              {item.href === "/buckets" && (buckets?.length ?? 0) > 0 ? (
                <div className="ml-6 mt-px flex flex-col gap-px">
                  {(buckets ?? []).map((b) => {
                    const active = b.name === activeBucket;
                    return (
                      <Link
                        key={b.name}
                        href={`/buckets/${encodeURIComponent(b.name)}`}
                        className={cn(
                          "flex h-7 items-center rounded-md px-2 text-[13px] transition-colors",
                          active
                            ? "font-medium"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        style={
                          active
                            ? {
                                color: "var(--primary)",
                                background: "var(--primary-soft)",
                              }
                            : undefined
                        }
                      >
                        <span className="mr-2 h-1 w-1 rounded-full bg-current" />
                        <span className="truncate">{b.name}</span>
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      {/* 活动连接卡 */}
      <div className="border-t border-border p-3">
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {T.activeConnLabel}
        </p>
        {activeConn ? (
          <p className="truncate text-xs font-medium">{activeConn.name}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{T.noConn}</p>
        )}
      </div>
    </aside>
  );
}
