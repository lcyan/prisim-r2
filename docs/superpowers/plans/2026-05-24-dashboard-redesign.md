# Dashboard 重设计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Prisim R2 的 dashboard 从手写 CSS Grid 外壳升级为 shadcn sidebar-07 + 顶栏面包屑 + ⌘K + 暗色模式 + Tremor 图表的成熟脚手架,并把 `/dashboard` 从 placeholder 替换为实数据首页。

**Architecture:** 整体重写 `components/layout/app-shell.tsx` 为 `<SidebarProvider>` + `<SidebarInset>` 结构;顶栏面包屑承载 `connection / bucket / prefix` 三段,侧栏改为 flat 主导航;主色用 `next-themes` 管 `data-theme`,暗色用独立 `ModeProvider` 管 `data-mode`,共 6 套主题;Tremor Raw 图表 copy-in 到 `components/charts/`,后端新增一个 read-only `GET /api/dashboard/summary` route,在 D1 上并发 6 个聚合 query。

**Tech Stack:** Next.js 15 App Router (edge runtime) · React 19 · Tailwind v4 (`@theme` in CSS) · shadcn/ui new-york · TanStack Query v5 · Zustand v5 · Drizzle ORM · Cloudflare D1 · Recharts (新增) · Tremor Raw (copy-in) · Vitest

**Spec:** `docs/superpowers/specs/2026-05-24-dashboard-redesign-design.md`

---

## 文件结构概览

新建文件:

```
components/layout/
  app-sidebar.tsx                ← Sidebar 主导航
  app-topbar.tsx                 ← 顶栏外壳
  topbar-breadcrumb.tsx          ← 面包屑(路由→ segments 映射)
  topbar-connection-popover.tsx  ← connection 段 popover(新增,不要与
                                    components/features/connections/
                                    connection-switcher.tsx 混淆)
  topbar-bucket-popover.tsx      ← bucket 段 popover(从原
                                    features/dashboard/bucket-switcher.tsx 迁移)
  command-menu.tsx               ← ⌘K CommandDialog

components/features/dashboard/
  kpi-card.tsx                   ← KPI 卡
  ops-area-chart.tsx             ← Tremor AreaChart 包装
  ops-by-type-bar.tsx            ← 横向 progress bar 风格(不用 Tremor BarChart)
  recent-activity.tsx            ← 最近活动列表(audit 行精简版)
  range-toggle.tsx               ← 7d / 30d 切换 segmented control
  format-delta.ts                ← delta% 计算(纯函数,易测)

components/charts/               ← Tremor Raw copy-in
  card.tsx
  area-chart.tsx
  bar-chart.tsx
  tracker.tsx

components/ui/                   ← shadcn add 输出
  sidebar.tsx
  breadcrumb.tsx
  command.tsx
  sheet.tsx
  tooltip.tsx
  separator.tsx

lib/dashboard/
  summary.ts                     ← server-only,6 D1 queries 并发

hooks/
  use-dashboard.ts

stores/
  ui-store.ts                    ← 命令面板开关 + 模式(light/dark/system)持久化

components/providers/
  mode-provider.tsx              ← 独立的暗色模式 provider(读 ui-store)

app/api/dashboard/
  summary/route.ts
```

改造文件:

```
components/layout/app-shell.tsx       ← 整体重写
components/features/dashboard/theme-switcher.tsx   ← 双维 dropdown(主色 + 模式)
components/features/dashboard/logo.tsx             ← 适配 SidebarHeader
components/providers.tsx                           ← 嵌入 ModeProvider
app/(dashboard)/dashboard/page.tsx                 ← 全新首页内容
app/(dashboard)/buckets/page.tsx                   ← bucket 卡片列表
app/(dashboard)/settings/page.tsx                  ← 加 tabs
app/globals.css                                    ← 暗色 token + 删除废弃布局原语
lib/api/schemas.ts                                 ← DashboardSummaryQuerySchema
lib/api/types.ts                                   ← DashboardSummary
lib/api/rate-limit.ts                              ← dashboardSummaryByUser policy + bundle
```

删除文件:

```
components/features/files/breadcrumb.tsx           ← 顶栏面包屑接管 prefix 段
components/features/dashboard/bucket-switcher.tsx  ← 迁移到 layout/topbar-bucket-popover.tsx
```

---

## Phase 1 · 脚手架引入

> 目标:把 AppShell 从手写 CSS Grid 替换为 `SidebarProvider`,引入 shadcn 必要组件。本阶段结束时所有现有页面可正常打开,视觉骨架就位(面包屑暂为占位)。

### Task 1.1: 外部依赖前置探测

**Files:**
- 临时探测,不入 commit。验证 shadcn / Tremor / Recharts 在当前栈的可用性。

- [x] **Step 1: 试跑 shadcn sidebar add**

Run:
```bash
cd /root/code/prisim-r2
pnpm dlx shadcn@latest add sidebar --yes 2>&1 | head -30
```

Expected: 在 `components/ui/sidebar.tsx` 生成文件,无 schema 错误。若失败(版本不兼容),记录错误信息并停在这一步,不要继续 Phase 1。

- [x] **Step 2: 检查生成的 sidebar.tsx 在 Tailwind v4 下能用**

Read 该文件首 40 行,确认它没有用 `tailwind.config.js` 才能识别的类名,只用 shadcn 桥接好的语义类(`bg-sidebar`、`text-sidebar-foreground` 等)。

如果 shadcn 用了 `data-[state=open]` 这样的 v4 默认就支持的语法,继续。如果用了 v3 才有的某些 plugin 类(如 `tailwindcss-animate`),需要确认 `app/globals.css` 是否需要补 `@plugin "tailwindcss-animate";` 之类的指令。

- [x] **Step 3: 探测 Tremor Raw area-chart 与 v4 兼容**

Run:
```bash
curl -s https://raw.tremor.so/api/component/area-chart 2>&1 | head -1
```

如果该端点不可用,跳过——后续 Phase 4 改为从 https://github.com/tremorlabs/tremor-raw 仓库复制源码即可。这步只是早期探测,不阻塞 Phase 1。

- [x] **Step 4: 探测 recharts edge 兼容**

不需要安装,仅查文档要点。recharts 文档明确说必须在 client component 内使用,Phase 4 的图表组件都会带 `"use client"`。无需在 Phase 1 验证。

- [x] **Step 5: 回滚探测改动**

Run:
```bash
git -C /root/code/prisim-r2 status
```

如果 `components/ui/sidebar.tsx` 是新文件,**保留**它(Task 1.2 会用)。其他探测产生的临时 deps / lockfile 修改,如果有不该提交的,`git restore` 掉。

### Task 1.2: 完整引入 shadcn 组件

**Files:**
- Create: `components/ui/sidebar.tsx`, `components/ui/breadcrumb.tsx`, `components/ui/command.tsx`, `components/ui/sheet.tsx`, `components/ui/tooltip.tsx`, `components/ui/separator.tsx`(都由 shadcn CLI 生成)

- [x] **Step 1: 跑 shadcn add 一次性补齐**

Run:
```bash
pnpm dlx shadcn@latest add breadcrumb command sheet tooltip separator --yes
```

Expected: 5 个文件生成到 `components/ui/`(sidebar 已在 Task 1.1 生成)。

- [x] **Step 2: 检查没有破坏已有 ui 文件**

Run:
```bash
git -C /root/code/prisim-r2 status components/ui/
```

Expected: 只看到新文件,没有已有文件(button/badge/dialog/...)被修改。如果有,`git restore` 恢复。

- [x] **Step 3: 跑 typecheck 确保新文件能编译**

Run:
```bash
pnpm typecheck 2>&1 | tail -20
```

Expected: 退出码 0。如果失败,检查是否缺 peer dep(如 `cmdk`、`@radix-ui/react-tooltip`),用 `pnpm add` 补齐。

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add components/ui/ package.json pnpm-lock.yaml
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(ui): add shadcn sidebar, breadcrumb, command, sheet, tooltip, separator

Generated via shadcn@latest CLI. Components/ui is in .prettierignore so
no formatting touch-up. These primitives back the new SidebarProvider
shell + ⌘K command menu introduced in this branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.3: AppSidebar 组件

**Files:**
- Create: `components/layout/app-sidebar.tsx`
- Test: `tests/unit/features/app-sidebar.test.tsx`

- [x] **Step 1: 写失败测试**

Create `tests/unit/features/app-sidebar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MemoryRouterProvider } from "@/tests/stubs/memory-router";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/app-sidebar";

function renderSidebar(pathname: string) {
  return render(
    <MemoryRouterProvider pathname={pathname}>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouterProvider>,
  );
}

describe("AppSidebar", () => {
  it("renders all 6 nav items with Chinese labels", () => {
    renderSidebar("/dashboard");
    for (const label of ["仪表盘", "存储桶", "分享链接", "审计日志", "连接管理", "设置"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("marks current route as active", () => {
    renderSidebar("/audit");
    const link = screen.getByRole("link", { name: /审计日志/ });
    expect(link).toHaveAttribute("data-active", "true");
  });

  it("active state uses prefix matching for nested routes", () => {
    renderSidebar("/buckets/my-bucket/foo/");
    const link = screen.getByRole("link", { name: /存储桶/ });
    expect(link).toHaveAttribute("data-active", "true");
  });

  it("renders brand header", () => {
    renderSidebar("/dashboard");
    expect(screen.getByText("Prisim R2")).toBeInTheDocument();
  });
});
```

Also create `tests/stubs/memory-router.tsx`(if not present — minimal Next.js router stub):

```tsx
import type { ReactNode } from "react";
import { vi } from "vitest";

let currentPathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

export function MemoryRouterProvider({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  currentPathname = pathname;
  return <>{children}</>;
}
```

- [x] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm test tests/unit/features/app-sidebar.test.tsx 2>&1 | tail -15
```

Expected: FAIL with "Cannot find module '@/components/layout/app-sidebar'"。

- [x] **Step 3: 实现 AppSidebar**

Create `components/layout/app-sidebar.tsx`:

```tsx
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
  { label: T.navDashboard, href: "/dashboard", icon: LayoutDashboard, matchPrefixes: ["/dashboard"] },
  { label: T.navBuckets, href: "/buckets", icon: Database, matchPrefixes: ["/buckets"] },
  { label: T.navShares, href: "/shares", icon: Link2, matchPrefixes: ["/shares"] },
  { label: T.navAudit, href: "/audit", icon: FileClock, matchPrefixes: ["/audit"] },
];

const ADMIN_NAV: readonly NavItem[] = [
  { label: T.navConnections, href: "/connections", icon: Plug, matchPrefixes: ["/connections", "/settings/connections"] },
  { label: T.navSettings, href: "/settings", icon: Settings, matchPrefixes: ["/settings"] },
];

function isActive(pathname: string, item: NavItem): boolean {
  return item.matchPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AppSidebar() {
  const pathname = usePathname() ?? "";
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground">
            P
          </div>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold">{T.brand}</p>
            <p className="truncate text-[11px] text-muted-foreground">{T.brandSub}</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{T.groupMain}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN_NAV.map((item) => (
                <NavRow key={item.href} item={item} active={isActive(pathname, item)} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{T.groupAdmin}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {ADMIN_NAV.map((item) => (
                <NavRow key={item.href} item={item} active={isActive(pathname, item)} />
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
```

- [x] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm test tests/unit/features/app-sidebar.test.tsx 2>&1 | tail -15
```

Expected: 4/4 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/app-sidebar.tsx tests/unit/features/app-sidebar.test.tsx tests/stubs/memory-router.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): add AppSidebar with flat nav + admin group

Replaces hand-rolled sidebar in app-shell.tsx (next task). Uses
shadcn SidebarMenuButton with collapsible=icon so the [☰] toggle
collapses to 56px and hover-tooltips kick in. No bucket sub-tree
and no active-connection card — both move to the topbar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.4: 顶栏占位组件(AppTopbar v1,不带面包屑)

**Files:**
- Create: `components/layout/app-topbar.tsx`

Phase 2 会在此基础上加面包屑。本 task 只搭骨架,把现有 `ThemeSwitcher` / `UserMenu` 挂上。

- [x] **Step 1: 实现 AppTopbar v1**

Create `components/layout/app-topbar.tsx`:

```tsx
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
```

- [x] **Step 2: 跑 typecheck**

Run:
```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 退出码 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/app-topbar.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): add AppTopbar shell with SidebarTrigger + theme/user

Phase 1 placeholder — breadcrumb segment is a static string. Phase 2
will swap it for route-aware TopbarBreadcrumb.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.5: CommandMenu 占位 + 全局 ui-store

**Files:**
- Create: `stores/ui-store.ts`
- Create: `components/layout/command-menu.tsx`
- Test: `tests/unit/stores/ui-store.test.ts`

- [x] **Step 1: 写 ui-store 失败测试**

Create `tests/unit/stores/ui-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "@/stores/ui-store";

describe("useUiStore — commandMenu", () => {
  beforeEach(() => {
    useUiStore.setState({ commandMenuOpen: false, mode: "system" });
  });

  it("opens command menu", () => {
    useUiStore.getState().openCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(true);
  });

  it("closes command menu", () => {
    useUiStore.setState({ commandMenuOpen: true });
    useUiStore.getState().closeCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(false);
  });

  it("toggles command menu", () => {
    useUiStore.getState().toggleCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(true);
    useUiStore.getState().toggleCommandMenu();
    expect(useUiStore.getState().commandMenuOpen).toBe(false);
  });
});

describe("useUiStore — mode", () => {
  beforeEach(() => {
    useUiStore.setState({ commandMenuOpen: false, mode: "system" });
  });

  it("default mode is 'system'", () => {
    expect(useUiStore.getState().mode).toBe("system");
  });

  it("setMode persists", () => {
    useUiStore.getState().setMode("dark");
    expect(useUiStore.getState().mode).toBe("dark");
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm test tests/unit/stores/ui-store.test.ts 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module '@/stores/ui-store'"。

- [x] **Step 3: 实现 ui-store**

Create `stores/ui-store.ts`:

```ts
// stores/ui-store.ts
//
// UI 状态(非业务数据)。两条独立的"游标":
//   - commandMenuOpen: ⌘K 弹窗开关
//   - mode: 暗色模式偏好(localStorage 持久化)
//
// 主色(blue/orange/green)仍由 next-themes 管理(see components/providers.tsx),
// 不进入这个 store。

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Mode = "light" | "dark" | "system";

interface UiState {
  commandMenuOpen: boolean;
  openCommandMenu: () => void;
  closeCommandMenu: () => void;
  toggleCommandMenu: () => void;

  mode: Mode;
  setMode: (mode: Mode) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      commandMenuOpen: false,
      openCommandMenu: () => set({ commandMenuOpen: true }),
      closeCommandMenu: () => set({ commandMenuOpen: false }),
      toggleCommandMenu: () => set((s) => ({ commandMenuOpen: !s.commandMenuOpen })),

      mode: "system",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "prisim-ui",
      storage: createJSONStorage(() => localStorage),
      // 命令面板开关属于"瞬时 UI",不持久化;只持久化 mode。
      partialize: (s) => ({ mode: s.mode }),
    },
  ),
);
```

- [x] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm test tests/unit/stores/ui-store.test.ts 2>&1 | tail -10
```

Expected: 5/5 PASS。

- [x] **Step 5: 实现 CommandMenu 占位**

Create `components/layout/command-menu.tsx`:

```tsx
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
```

- [x] **Step 6: 提交**

```bash
git -C /root/code/prisim-r2 add stores/ui-store.ts components/layout/command-menu.tsx tests/unit/stores/ui-store.test.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): add ⌘K command menu skeleton + ui-store

Phase 1 navigation-only. Phase 2 adds bucket/connection items;
Phase 3 adds theme/mode actions. mode persists via zustand/persist,
commandMenuOpen is ephemeral.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.6: 重写 app-shell.tsx 用 SidebarProvider

**Files:**
- Modify: `components/layout/app-shell.tsx`(整体重写)
- Modify: `app/globals.css`(删除废弃布局原语)

- [x] **Step 1: 整体重写 app-shell.tsx**

Replace contents of `components/layout/app-shell.tsx`:

```tsx
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
```

- [x] **Step 2: 删除 globals.css 中废弃的布局原语**

Edit `app/globals.css` — 在第 62 行附近删除以下行:

```css
  /* 布局原语 */
  --topbar-h: 3.5rem;        /* 56px */
  --sidebar-w: 14.5rem;       /* 232px */
  --row-h-tight: 2.25rem;     /* 36px */
  --row-h: 2.5rem;            /* 40px */
```

并在文件末尾(`.signal-bar` 处)删除:

```css
/* 侧栏活跃指示条（2px primary 色） */
.signal-bar {
  box-shadow: inset 2px 0 0 0 var(--primary);
}
```

新的 sidebar 用 shadcn 自带的高亮(`data-active=true` 触发的 `bg-sidebar-accent`)。如果后续要回到类似"2px primary 色条"的视觉,需要在 shadcn sidebar 的 ItemButton 上覆盖样式,不在 globals.css 里改。

- [x] **Step 3: 跑 typecheck + lint**

Run:
```bash
pnpm typecheck 2>&1 | tail -10
pnpm lint 2>&1 | tail -10
```

Expected: 双 0 退出码。

- [x] **Step 4: 启动 preview 手动验证**

Run(后台启动):
```bash
pnpm preview
```

Open http://localhost:8788/login,登录后访问 `/dashboard` / `/buckets` / `/connections` / `/audit` / `/shares` / `/settings`,确认:
- 侧栏 6 项,分两组(主导航 / 设置)
- 顶栏占位面包屑显示 "Prisim R2"
- 主题切换、用户菜单仍可用
- ⌘K(macOS)或 ctrl+K(linux/windows)能打开命令面板,选导航能跳转
- 折叠/展开侧栏正常(点 hamburger 或按 `[`)

如果有页面报错,在记下错误后回到该 task 修;不要继续 Task 1.7。

Stop preview server。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/app-shell.tsx app/globals.css
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
refactor(layout): rewrite app-shell.tsx to use SidebarProvider

Replaces hand-rolled CSS-Grid template with shadcn sidebar-07 stack.
Removes --topbar-h/--sidebar-w/--row-h legacy tokens and .signal-bar
helper from globals.css — shadcn sidebar self-manages width and the
active highlight uses bg-sidebar-accent now.

Topbar still shows a static placeholder breadcrumb; Phase 2 wires
the route-aware TopbarBreadcrumb.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.7: Phase 1 验收

- [x] **Step 1: 跑全套质量门**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -20
```

Expected: 全绿。

- [x] **Step 2: 跑 build:pages 确认产物**

Run:
```bash
pnpm build:pages 2>&1 | tail -20
ls -lh /root/code/prisim-r2/.vercel/output/static/_worker.js 2>&1
```

Expected: 构建成功,worker.js 体积仍 < 1MB(基线参考)。

- [x] **Step 3: 记录基线**

把 worker.js 体积记到本地 scratch(不入 commit),用于 Phase 4/5 对比。例如:

```bash
ls -l /root/code/prisim-r2/.vercel/output/static/_worker.js | awk '{print "phase1-baseline:", $5}'
```

---

## Phase 2 · 顶栏面包屑 IA 切换

> 目标:把 `connection / bucket / prefix` 三段层级搬到顶栏面包屑,删除现有的 files/breadcrumb.tsx 与旧版 dashboard/bucket-switcher.tsx。本阶段结束时切 connection / bucket / prefix 都从顶栏走。

### Task 2.1: pathname → breadcrumb segments 映射纯函数 + 测试

**Files:**
- Create: `components/layout/breadcrumb-segments.ts`
- Test: `tests/unit/features/breadcrumb-segments.test.ts`

- [x] **Step 1: 写失败测试**

Create `tests/unit/features/breadcrumb-segments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveSegments } from "@/components/layout/breadcrumb-segments";

describe("resolveSegments — connection-scoped routes", () => {
  it("/dashboard → conn + 仪表盘", () => {
    expect(resolveSegments("/dashboard")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "仪表盘" },
    ]);
  });

  it("/buckets → conn + 存储桶", () => {
    expect(resolveSegments("/buckets")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
    ]);
  });

  it("/buckets/my-bucket → conn + 存储桶 + bucket(my-bucket)", () => {
    expect(resolveSegments("/buckets/my-bucket")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
      { kind: "bucket", name: "my-bucket" },
    ]);
  });

  it("/buckets/my-bucket/foo/bar → conn + 存储桶 + bucket + prefix", () => {
    expect(resolveSegments("/buckets/my-bucket/foo/bar")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
      { kind: "bucket", name: "my-bucket" },
      { kind: "prefix", path: "foo/bar/" },
    ]);
  });

  it("/buckets/my-bucket/foo/ trailing slash normalizes", () => {
    expect(resolveSegments("/buckets/my-bucket/foo/")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
      { kind: "bucket", name: "my-bucket" },
      { kind: "prefix", path: "foo/" },
    ]);
  });

  it("/shares → conn + 分享链接", () => {
    expect(resolveSegments("/shares")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "分享链接" },
    ]);
  });

  it("/audit → conn + 审计日志", () => {
    expect(resolveSegments("/audit")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "审计日志" },
    ]);
  });
});

describe("resolveSegments — global routes (no conn segment)", () => {
  it("/connections → 连接管理 only", () => {
    expect(resolveSegments("/connections")).toEqual([
      { kind: "static", label: "连接管理" },
    ]);
  });

  it("/settings → 设置 only", () => {
    expect(resolveSegments("/settings")).toEqual([
      { kind: "static", label: "设置" },
    ]);
  });

  it("/settings/connections → 设置 + 连接管理", () => {
    expect(resolveSegments("/settings/connections")).toEqual([
      { kind: "static", label: "设置" },
      { kind: "static", label: "连接管理" },
    ]);
  });
});

describe("resolveSegments — fallback", () => {
  it("unknown route → empty array", () => {
    expect(resolveSegments("/nope/123")).toEqual([]);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm test tests/unit/features/breadcrumb-segments.test.ts 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module"。

- [x] **Step 3: 实现 resolveSegments**

Create `components/layout/breadcrumb-segments.ts`:

```ts
// components/layout/breadcrumb-segments.ts
//
// 纯函数:把 next/navigation 的 pathname 映射为顶栏面包屑要渲染的段。
// 每一段是一个 discriminated union 节点,Topbar 组件按 kind 切渲染。
//
// 与 next/navigation 解耦 → 易测、易演进。

export type Segment =
  | { kind: "connection" }
  | { kind: "bucket"; name: string }
  | { kind: "prefix"; path: string }
  | { kind: "static"; label: string };

const SCOPED_ROUTES: Array<{ prefix: string; label: string }> = [
  { prefix: "/dashboard", label: "仪表盘" },
  { prefix: "/shares", label: "分享链接" },
  { prefix: "/audit", label: "审计日志" },
];

export function resolveSegments(pathname: string): Segment[] {
  // 顺序敏感:/settings/connections 必须在 /settings 与 /connections 之前判断
  if (pathname === "/settings/connections" || pathname.startsWith("/settings/connections/")) {
    return [
      { kind: "static", label: "设置" },
      { kind: "static", label: "连接管理" },
    ];
  }
  if (pathname === "/connections" || pathname.startsWith("/connections/")) {
    return [{ kind: "static", label: "连接管理" }];
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return [{ kind: "static", label: "设置" }];
  }

  // /buckets[/[bucket][/[...prefix]]]
  if (pathname === "/buckets" || pathname.startsWith("/buckets/")) {
    const segs: Segment[] = [
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
    ];
    const rest = pathname.slice("/buckets".length);
    if (rest.length === 0 || rest === "/") return segs;
    const parts = rest.replace(/^\//, "").split("/");
    const bucket = parts[0];
    if (bucket) segs.push({ kind: "bucket", name: decodeURIComponent(bucket) });
    if (parts.length > 1) {
      const prefixSegments = parts.slice(1).filter((p) => p.length > 0);
      if (prefixSegments.length > 0) {
        segs.push({
          kind: "prefix",
          path: `${prefixSegments.map(decodeURIComponent).join("/")}/`,
        });
      }
    }
    return segs;
  }

  for (const route of SCOPED_ROUTES) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) {
      return [{ kind: "connection" }, { kind: "static", label: route.label }];
    }
  }
  return [];
}
```

- [x] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm test tests/unit/features/breadcrumb-segments.test.ts 2>&1 | tail -10
```

Expected: 10/10 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/breadcrumb-segments.ts tests/unit/features/breadcrumb-segments.test.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): add pathname → breadcrumb segments resolver

Pure function, fully unit-tested. TopbarBreadcrumb (next task)
renders these segments and attaches popovers/links per kind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2: ConnectionPopover(顶栏 connection 段)

**Files:**
- Create: `components/layout/topbar-connection-popover.tsx`
- Test: `tests/unit/features/topbar-connection-popover.test.tsx`

注意:此文件与 `components/features/connections/connection-switcher.tsx`(预登陆/`/connections` 页用)不同,放在 layout/ 目录避免冲突。

- [x] **Step 1: 写失败测试**

Create `tests/unit/features/topbar-connection-popover.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-connections", () => ({
  useConnections: vi.fn(),
}));
vi.mock("@/stores/active-connection", () => ({
  useActiveConnectionStore: vi.fn(),
}));

import { useConnections } from "@/hooks/use-connections";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { TopbarConnectionPopover } from "@/components/layout/topbar-connection-popover";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("TopbarConnectionPopover", () => {
  beforeEach(() => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: "01ABC",
      setActiveConnectionId: vi.fn(),
      clearActiveConnectionId: vi.fn(),
    });
  });

  it("renders active connection name as trigger", () => {
    vi.mocked(useConnections).mockReturnValue({
      data: [
        { id: "01ABC", name: "prod-main", accountId: "x", accessKeyMasked: "y", createdAt: 0, lastUsedAt: null },
      ],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<TopbarConnectionPopover />));
    expect(screen.getByRole("button", { name: /prod-main/ })).toBeInTheDocument();
  });

  it("shows placeholder when no connection selected", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: null,
      setActiveConnectionId: vi.fn(),
      clearActiveConnectionId: vi.fn(),
    });
    vi.mocked(useConnections).mockReturnValue({ data: [], isPending: false, isError: false } as never);
    render(withQuery(<TopbarConnectionPopover />));
    expect(screen.getByRole("button", { name: /选择连接/ })).toBeInTheDocument();
  });

  it("opens popover with all connections + new-connection link on click", async () => {
    const user = userEvent.setup();
    vi.mocked(useConnections).mockReturnValue({
      data: [
        { id: "01ABC", name: "prod-main", accountId: "x", accessKeyMasked: "y", createdAt: 0, lastUsedAt: null },
        { id: "02DEF", name: "staging", accountId: "x", accessKeyMasked: "y", createdAt: 0, lastUsedAt: null },
      ],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<TopbarConnectionPopover />));
    await user.click(screen.getByRole("button", { name: /prod-main/ }));
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /新建连接/ })).toBeInTheDocument();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm test tests/unit/features/topbar-connection-popover.test.tsx 2>&1 | tail -10
```

Expected: FAIL — module not found。

- [x] **Step 3: 实现 TopbarConnectionPopover**

Create `components/layout/topbar-connection-popover.tsx`:

```tsx
"use client";

// components/layout/topbar-connection-popover.tsx
//
// 顶栏面包屑首段 "connection" 的 popover trigger。
//
// 注意:此文件与 components/features/connections/connection-switcher.tsx
// 不是同一个组件 —— 后者是预登陆 / /connections 页用的"新建连接"对话框组合;
// 本组件只是顶栏的"切换 / 跳转新建"入口。

import Link from "next/link";
import { Check, ChevronDown, Plug, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useConnections } from "@/hooks/use-connections";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { cn } from "@/lib/utils";

const T = {
  pickPrompt: "选择连接",
  manage: "管理连接",
  add: "新建连接",
  active: "当前连接",
} as const;

export function TopbarConnectionPopover() {
  const { data: connections } = useConnections();
  const activeId = useActiveConnectionStore((s) => s.activeConnectionId);
  const setActive = useActiveConnectionStore((s) => s.setActiveConnectionId);

  const active = connections?.find((c) => c.id === activeId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
        <Plug className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
        <span className={cn("max-w-[160px] truncate", !active && "text-muted-foreground")}>
          {active?.name ?? T.pickPrompt}
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>{T.active}</DropdownMenuLabel>
        {(connections ?? []).map((conn) => (
          <DropdownMenuItem
            key={conn.id}
            onSelect={() => setActive(conn.id)}
            className="flex items-center justify-between"
          >
            <span className="truncate">{conn.name}</span>
            {conn.id === activeId ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/connections" className="flex items-center gap-2">
            <Plus className="h-3.5 w-3.5" />
            {T.add}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [x] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm test tests/unit/features/topbar-connection-popover.test.tsx 2>&1 | tail -10
```

Expected: 3/3 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/topbar-connection-popover.tsx tests/unit/features/topbar-connection-popover.test.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): add TopbarConnectionPopover for breadcrumb connection segment

Lives in components/layout/ to avoid namespace collision with
components/features/connections/connection-switcher.tsx (the
existing pre-login / /connections-page connection picker).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.3: BucketPopover(顶栏 bucket 段,迁移旧 bucket-switcher)

**Files:**
- Create: `components/layout/topbar-bucket-popover.tsx`
- Delete: `components/features/dashboard/bucket-switcher.tsx`(旧 dropdown)
- Test: `tests/unit/features/topbar-bucket-popover.test.tsx`

- [x] **Step 1: 写失败测试**

Create `tests/unit/features/topbar-bucket-popover.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-buckets", () => ({ useBuckets: vi.fn() }));
vi.mock("@/stores/active-connection", () => ({
  useActiveConnectionStore: vi.fn(),
}));

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { TopbarBucketPopover } from "@/components/layout/topbar-bucket-popover";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("TopbarBucketPopover", () => {
  it("shows current bucket name", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: "01ABC",
      activeBucket: "assets",
    } as never);
    vi.mocked(useBuckets).mockReturnValue({
      data: [{ name: "assets", createdAt: 0 }, { name: "backups", createdAt: 0 }],
      isPending: false,
    } as never);
    render(withQuery(<TopbarBucketPopover currentBucket="assets" />));
    expect(screen.getByRole("button", { name: /assets/ })).toBeInTheDocument();
  });

  it("lists all buckets in popover", async () => {
    const user = userEvent.setup();
    vi.mocked(useActiveConnectionStore).mockReturnValue({
      activeConnectionId: "01ABC",
      activeBucket: "assets",
    } as never);
    vi.mocked(useBuckets).mockReturnValue({
      data: [{ name: "assets", createdAt: 0 }, { name: "backups", createdAt: 0 }],
      isPending: false,
    } as never);
    render(withQuery(<TopbarBucketPopover currentBucket="assets" />));
    await user.click(screen.getByRole("button", { name: /assets/ }));
    expect(screen.getByText("backups")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run:
```bash
pnpm test tests/unit/features/topbar-bucket-popover.test.tsx 2>&1 | tail -10
```

Expected: FAIL — module not found。

- [x] **Step 3: 实现 TopbarBucketPopover**

Create `components/layout/topbar-bucket-popover.tsx`:

```tsx
"use client";

// components/layout/topbar-bucket-popover.tsx
//
// 顶栏面包屑 bucket 段:显示当前 bucket 名,点击展开同 connection 下所有
// bucket 列表 + "查看全部 bucket"链接(跳 /buckets)。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Database, ListIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";

const T = {
  current: "当前 Bucket",
  viewAll: "查看全部 Bucket",
  empty: "暂无 Bucket",
} as const;

interface TopbarBucketPopoverProps {
  currentBucket: string;
}

export function TopbarBucketPopover({ currentBucket }: TopbarBucketPopoverProps) {
  const router = useRouter();
  const activeId = useActiveConnectionStore((s) => s.activeConnectionId);
  const { data: buckets } = useBuckets(activeId);

  function goto(bucket: string) {
    router.push(`/buckets/${encodeURIComponent(bucket)}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
        <Database className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} />
        <span className="max-w-[180px] truncate">{currentBucket}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>{T.current}</DropdownMenuLabel>
        {(buckets ?? []).length === 0 ? (
          <DropdownMenuItem disabled>{T.empty}</DropdownMenuItem>
        ) : (
          (buckets ?? []).map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => goto(b.name)}
              className="flex items-center justify-between"
            >
              <span className="truncate font-mono text-xs">{b.name}</span>
              {b.name === currentBucket ? <Check className="h-3.5 w-3.5" /> : null}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/buckets" className="flex items-center gap-2">
            <ListIcon className="h-3.5 w-3.5" />
            {T.viewAll}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [x] **Step 4: 跑测试确认通过**

Run:
```bash
pnpm test tests/unit/features/topbar-bucket-popover.test.tsx 2>&1 | tail -10
```

Expected: 2/2 PASS。

- [x] **Step 5: 删除旧 bucket-switcher**

Run:
```bash
git -C /root/code/prisim-r2 rm components/features/dashboard/bucket-switcher.tsx
```

确认没有其他地方 import 它(grep):

```bash
grep -rn "features/dashboard/bucket-switcher\|BucketSwitcher" /root/code/prisim-r2/{app,components,hooks,lib,stores} 2>&1 | grep -v "topbar-bucket-popover" || echo "no remaining refs"
```

Expected: 没有其他 import(若有,需在引用处替换为 `TopbarBucketPopover` 或移除)。

- [x] **Step 6: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/topbar-bucket-popover.tsx tests/unit/features/topbar-bucket-popover.test.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): replace dashboard/bucket-switcher with TopbarBucketPopover

Moves the bucket dropdown from "topbar standalone widget" to
"breadcrumb bucket segment popover". Deletes the old file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.4: TopbarBreadcrumb(整合 segments + popovers + prefix 渲染)

**Files:**
- Create: `components/layout/topbar-breadcrumb.tsx`

- [x] **Step 1: 实现 TopbarBreadcrumb**

Create `components/layout/topbar-breadcrumb.tsx`:

```tsx
"use client";

// components/layout/topbar-breadcrumb.tsx
//
// 渲染顶栏面包屑。把 resolveSegments(pathname) 的输出转成具体节点:
//   - connection → <TopbarConnectionPopover />
//   - bucket → <TopbarBucketPopover currentBucket={name} />
//   - prefix → 纯文本(最长保留最后两段,前面用 ".../")
//   - static → 纯文本

import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { resolveSegments, type Segment } from "@/components/layout/breadcrumb-segments";
import { TopbarConnectionPopover } from "@/components/layout/topbar-connection-popover";
import { TopbarBucketPopover } from "@/components/layout/topbar-bucket-popover";

export function TopbarBreadcrumb() {
  const pathname = usePathname() ?? "";
  const segments = resolveSegments(pathname);

  if (segments.length === 0) return null;

  return (
    <nav aria-label="面包屑" className="flex items-center gap-1 text-sm">
      {segments.map((seg, idx) => (
        <span key={`${seg.kind}-${idx}`} className="flex items-center gap-1">
          {idx > 0 ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : null}
          <SegmentNode segment={seg} />
        </span>
      ))}
    </nav>
  );
}

function SegmentNode({ segment }: { segment: Segment }) {
  switch (segment.kind) {
    case "connection":
      return <TopbarConnectionPopover />;
    case "bucket":
      return <TopbarBucketPopover currentBucket={segment.name} />;
    case "prefix":
      return <PrefixSegment path={segment.path} />;
    case "static":
      return <span className="px-1 text-muted-foreground">{segment.label}</span>;
  }
}

function PrefixSegment({ path }: { path: string }) {
  // path 形如 "a/b/c/"。最长保留最后 2 段,前面用 .../
  const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
  let display: string;
  if (parts.length <= 2) {
    display = `${parts.join("/")}/`;
  } else {
    display = `…/${parts.slice(-2).join("/")}/`;
  }
  return (
    <span
      className="max-w-[280px] truncate px-1 font-mono text-xs text-foreground"
      title={path}
    >
      {display}
    </span>
  );
}
```

- [x] **Step 2: 把 AppTopbar 接上 TopbarBreadcrumb**

Modify `components/layout/app-topbar.tsx` — 替换占位面包屑:

```tsx
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
```

- [x] **Step 3: 实现 CommandMenuTrigger(顶栏的"搜索 · ⌘K"按钮)**

Create `components/layout/command-menu-trigger.tsx`:

```tsx
"use client";

// components/layout/command-menu-trigger.tsx
//
// 顶栏右侧的 "搜索 · ⌘K" 胶囊。点击或键盘 ⌘K 触发 CommandMenu。
// 键盘绑定本身在 <CommandMenu /> 内部全局监听;本组件只做点击入口
// + 视觉提示。

import { Search } from "lucide-react";
import { useUiStore } from "@/stores/ui-store";

const T = { trigger: "搜索" } as const;

export function CommandMenuTrigger() {
  const open = useUiStore((s) => s.openCommandMenu);
  return (
    <button
      type="button"
      onClick={open}
      className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground md:flex"
      aria-label="打开命令面板"
    >
      <Search className="h-3 w-3" strokeWidth={1.75} />
      <span>{T.trigger}</span>
      <span className="ml-2 rounded border border-border px-1.5 font-mono text-[10px] tracking-tight">⌘K</span>
    </button>
  );
}
```

- [x] **Step 4: typecheck + lint**

```bash
pnpm typecheck && pnpm lint 2>&1 | tail -10
```

Expected: 双 0 退出码。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/topbar-breadcrumb.tsx components/layout/command-menu-trigger.tsx components/layout/app-topbar.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): wire TopbarBreadcrumb + command trigger into AppTopbar

Replaces Phase 1 placeholder. Breadcrumb renders three kinds of
segments (connection/bucket popovers, prefix label, static text)
depending on pathname.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.5: 删除 files/breadcrumb.tsx(prefix 接管)

**Files:**
- Delete: `components/features/files/breadcrumb.tsx`
- Modify: `app/(dashboard)/buckets/[bucket]/[[...prefix]]/page.tsx`(去掉对 Breadcrumb 的引用)

- [x] **Step 1: 找出谁还在 import 旧 breadcrumb**

Run:
```bash
grep -rn "features/files/breadcrumb" /root/code/prisim-r2/{app,components} 2>&1
```

Expected: 至少 `app/(dashboard)/buckets/[bucket]/[[...prefix]]/page.tsx` 引用。

- [x] **Step 2: 改造对象浏览页**

Read 该文件,定位到 `<Breadcrumb ... />` 渲染处。删除该 import 与 JSX。如果有 props 透传(如 `bucket`、`prefix`),保留它们用于其他子组件,只是不再渲染 breadcrumb。

不需要新加什么——顶栏已经接管。Page 顶部该有的页眉(如 "对象数 / 大小汇总")保留。

- [x] **Step 3: 删除旧文件**

```bash
git -C /root/code/prisim-r2 rm components/features/files/breadcrumb.tsx
```

- [x] **Step 4: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 0 退出码。如果报"Breadcrumb 未引用但 import",清理对应 import。

- [x] **Step 5: 手动验证**

启动 preview:

```bash
pnpm preview
```

访问 `/buckets/<some-bucket>/<some-prefix>/`,确认:
- 页面不再有"页面内 breadcrumb"行
- 顶栏面包屑显示 conn / 存储桶 / bucket / prefix
- 点击 bucket 段 popover 能切换
- 点击 connection 段 popover 能切换
- prefix 文本截断到最后两段(如果更深),title 显示全路径

Stop preview。

- [x] **Step 6: 提交**

```bash
git -C /root/code/prisim-r2 add -A
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
refactor(files): drop in-page Breadcrumb — topbar takes over

The new TopbarBreadcrumb renders the connection / bucket / prefix
chain at the page header level, so the duplicate inside the
object-browse page is now noise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.6: Phase 2 验收

- [x] **Step 1: 全套质量门**

```bash
pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -20
```

Expected: 全绿。

---

## Phase 3 · 暗色模式 + 二维主题

> 目标:加 6 套主题(主色 × 模式)。主色继续用 next-themes,模式用独立 `ModeProvider` + `useUiStore` 驱动。ThemeSwitcher 改为双维 dropdown。

### Task 3.1: globals.css 新增暗色 token

**Files:**
- Modify: `app/globals.css`

- [x] **Step 1: 在主色 token 块之后追加暗色 token**

Edit `app/globals.css`,在 `:root[data-theme="green"] { ... }` 之后追加:

```css
/* 暗色模式:语义层(背景 / 前景 / 边框 / 阴影) */
:root[data-mode="dark"] {
  --content-bg: #0B0D11;
  --surface: #14171C;
  --fg: #E6E7EA;
  --fg-2: #B0B4BB;
  --muted: #6B7280;
  --muted-2: #4B5563;
  --border: #1F2229;
  --border-strong: #2A2E36;
  --row-hover: #1A1D23;
  --code-bg: #14171C;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 14px rgba(0, 0, 0, 0.5);
  --shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.7);
}

/* 暗色 × 各主色:微调 primary 在深底上的对比度 */
:root[data-theme="blue"][data-mode="dark"] {
  --primary: #4391FF;
  --primary-hover: #69A7FF;
  --primary-active: #1F7AEB;
  --primary-soft: rgba(67, 145, 255, 0.14);
  --primary-soft-strong: rgba(67, 145, 255, 0.22);
  --hover: rgba(67, 145, 255, 0.10);
  --info: #4391FF;
  --info-soft: rgba(67, 145, 255, 0.14);
}
:root[data-theme="orange"][data-mode="dark"] {
  --primary: #FF8A33;
  --primary-hover: #FFA561;
  --primary-active: #EB6A0E;
  --primary-soft: rgba(255, 138, 51, 0.14);
  --primary-soft-strong: rgba(255, 138, 51, 0.22);
  --hover: rgba(255, 138, 51, 0.10);
  --info: #FF8A33;
  --info-soft: rgba(255, 138, 51, 0.14);
}
:root[data-theme="green"][data-mode="dark"] {
  --primary: #2FCD8A;
  --primary-hover: #5BDDA8;
  --primary-active: #14B377;
  --primary-soft: rgba(47, 205, 138, 0.14);
  --primary-soft-strong: rgba(47, 205, 138, 0.22);
  --hover: rgba(47, 205, 138, 0.10);
  --info: #2FCD8A;
  --info-soft: rgba(47, 205, 138, 0.14);
}
```

- [x] **Step 2: typecheck(确保 CSS 不影响 TS 编译)**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add app/globals.css
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(ui): add dark-mode tokens for all three primary themes

:root[data-mode="dark"] covers semantic layer (background, surface,
foreground, border, shadow). The three (theme × mode="dark") blocks
fine-tune --primary contrast for blue/orange/green against the dark
substrate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: ModeProvider

**Files:**
- Create: `components/providers/mode-provider.tsx`
- Modify: `components/providers.tsx`(嵌入 ModeProvider)

- [x] **Step 1: 实现 ModeProvider**

Create `components/providers/mode-provider.tsx`:

```tsx
"use client";

// components/providers/mode-provider.tsx
//
// 把 useUiStore.mode (light/dark/system) 解析成实际生效的 light/dark,
// 并写到 <html data-mode="...">。监听 prefers-color-scheme 变化使
// "system" 模式可以实时跟随。
//
// 与 next-themes 完全解耦:主色由 next-themes 写 data-theme,模式
// 由本组件写 data-mode,两者互不覆盖。

import { useEffect, type ReactNode } from "react";
import { useUiStore } from "@/stores/ui-store";

function resolveEffectiveMode(mode: "light" | "dark" | "system"): "light" | "dark" {
  if (mode === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const mode = useUiStore((s) => s.mode);

  useEffect(() => {
    const apply = () => {
      const effective = resolveEffectiveMode(mode);
      document.documentElement.setAttribute("data-mode", effective);
    };
    apply();
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);

  return <>{children}</>;
}
```

- [x] **Step 2: 在 providers.tsx 嵌入 ModeProvider**

Edit `components/providers.tsx`,在 `<ThemeProvider>` 内层、`<QueryClientProvider>` 外层加 `<ModeProvider>`:

```tsx
import { ModeProvider } from "@/components/providers/mode-provider";
// ...

return (
  <ThemeProvider
    attribute="data-theme"
    defaultTheme="blue"
    themes={["blue", "orange", "green"]}
    storageKey="prisim-r2-theme"
    enableSystem={false}
    enableColorScheme={false}
    disableTransitionOnChange
  >
    <ModeProvider>
      <QueryClientProvider client={queryClient}>
        {children}
        <UploadQueueProvider />
        <UploadDrawerContainer />
        <Toaster position="top-right" richColors closeButton offset={{ top: "4.5rem" }} />
      </QueryClientProvider>
    </ModeProvider>
  </ThemeProvider>
);
```

- [x] **Step 3: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add components/providers/mode-provider.tsx components/providers.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(ui): add ModeProvider for dark mode

Reads useUiStore.mode and writes data-mode to <html>. Listens to
prefers-color-scheme when mode === "system" so the OS preference
takes effect in real time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.3: ThemeSwitcher 改为双维 dropdown

**Files:**
- Modify: `components/features/dashboard/theme-switcher.tsx`(重写)
- Test: `tests/unit/features/theme-switcher.test.tsx`

- [x] **Step 1: 写测试**

Create `tests/unit/features/theme-switcher.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-themes", () => {
  let theme = "blue";
  return {
    useTheme: () => ({
      theme,
      setTheme: (t: string) => {
        theme = t;
      },
    }),
  };
});

import { useUiStore } from "@/stores/ui-store";
import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";

describe("ThemeSwitcher dual axis", () => {
  beforeEach(() => {
    useUiStore.setState({ mode: "system", commandMenuOpen: false });
  });

  it("primary color picker and mode picker both render", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    expect(screen.getByText("主色")).toBeInTheDocument();
    expect(screen.getByText("外观")).toBeInTheDocument();
  });

  it("clicking 暗色 updates ui-store", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    await user.click(screen.getByText("暗色"));
    expect(useUiStore.getState().mode).toBe("dark");
  });
});
```

- [x] **Step 2: 跑测试确认失败(组件签名变化)**

```bash
pnpm test tests/unit/features/theme-switcher.test.tsx 2>&1 | tail -10
```

Expected: FAIL(组件没改前)。

- [x] **Step 3: 重写 ThemeSwitcher**

Replace contents of `components/features/dashboard/theme-switcher.tsx`:

```tsx
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
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm test tests/unit/features/theme-switcher.test.tsx 2>&1 | tail -10
```

Expected: 2/2 PASS。

- [x] **Step 5: 手动验证 6 套主题**

启动 preview:

```bash
pnpm preview
```

打开 dashboard,点 ThemeSwitcher:
- 切 蓝/橙/绿 三主色,确认 `<html data-theme>` 变化 + UI 主色随之
- 切 亮/暗/系统 三模式,确认 `<html data-mode>` 变化 + 背景/前景/边框跟随
- 6 种组合(蓝×亮、蓝×暗、橙×亮、橙×暗、绿×亮、绿×暗)都点一遍,无视觉硬伤
- 刷新页面,主色与模式选择都被持久化(localStorage["prisim-r2-theme"] + "prisim-ui")

记下任何视觉问题(暗色下文本对比度、卡片边框 invisible 等),回到 Task 3.1 修 token。

Stop preview。

- [x] **Step 6: 提交**

```bash
git -C /root/code/prisim-r2 add components/features/dashboard/theme-switcher.tsx tests/unit/features/theme-switcher.test.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(ui): two-axis theme switcher (primary × mode)

Primary stays on next-themes; mode is driven by useUiStore so we
don't fight next-themes over <html attributes>. Six combinations
verified visually.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.4: CommandMenu 加主题/模式快捷动作

**Files:**
- Modify: `components/layout/command-menu.tsx`

- [x] **Step 1: 扩展 CommandMenu**

在现有 CommandMenu 中加入一组新 CommandGroup:

```tsx
// 在文件顶部加 import
import { useTheme } from "next-themes";

// 在 T 常量中扩充
const T = {
  // 现有...
  groupActions: "快捷动作",
  pickBlue: "切换主题 · 经典蓝",
  pickOrange: "切换主题 · 活力橙",
  pickGreen: "切换主题 · 清新绿",
  pickLight: "切换到亮色",
  pickDark: "切换到暗色",
  pickSystem: "跟随系统",
  newConnection: "新建连接",
} as const;

// 在组件内
const { setTheme } = useTheme();
const setMode = useUiStore((s) => s.setMode);

// 在 <CommandList> 内,<CommandGroup heading={T.groupNav}> 之后加
<CommandGroup heading={T.groupActions}>
  <CommandItem onSelect={run(() => router.push("/connections?new=1"))}>{T.newConnection}</CommandItem>
  <CommandItem onSelect={run(() => setTheme("blue"))}>{T.pickBlue}</CommandItem>
  <CommandItem onSelect={run(() => setTheme("orange"))}>{T.pickOrange}</CommandItem>
  <CommandItem onSelect={run(() => setTheme("green"))}>{T.pickGreen}</CommandItem>
  <CommandItem onSelect={run(() => setMode("light"))}>{T.pickLight}</CommandItem>
  <CommandItem onSelect={run(() => setMode("dark"))}>{T.pickDark}</CommandItem>
  <CommandItem onSelect={run(() => setMode("system"))}>{T.pickSystem}</CommandItem>
</CommandGroup>
```

注意:`/connections?new=1` 是个软约定 — 后续 `/connections` 页可以读 `?new=1` 自动打开"新建连接"对话框。本 task 不实现该读取,只是 command menu 跳转过去;`Connections` 页面下一步可以加这个 hook,不在 Phase 3 范围。

- [x] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add components/layout/command-menu.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(layout): add theme + mode quick actions to ⌘K command menu

Adds 6 items under "快捷动作": pick blue/orange/green, light/dark/system.
"新建连接" goes to /connections?new=1 — the page can opt into auto-
opening the create dialog by reading that query param in a later step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.5: Phase 3 验收

- [x] 全套门:`pnpm typecheck && pnpm lint && pnpm test` 全绿

---

## Phase 4 · Tremor + 图表基建

> 目标:引入 Recharts 依赖,copy-in Tremor Raw 4 个组件,实现 dashboard 专用 KPI / chart / activity / range-toggle 组件。本阶段结束时这些组件可独立挂载于一个临时 sandbox 路由 demo。

### Task 4.1: 安装 Recharts + copy Tremor Raw

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `components/charts/card.tsx`, `components/charts/area-chart.tsx`, `components/charts/bar-chart.tsx`, `components/charts/tracker.tsx`

- [x] **Step 1: 安装 recharts**

Run:
```bash
pnpm add recharts@^2.13.0
```

(版本选 2.x 最新稳定;Recharts 3 还在 alpha 时候按 2.x 走。)

- [x] **Step 2: copy Tremor Raw 源文件**

去 https://github.com/tremorlabs/tremor-raw/tree/main/src/components 找以下 4 个组件,把每个组件的 `.tsx` 内容下载到本地:

- `Card.tsx` → `components/charts/card.tsx`
- `AreaChart.tsx` → `components/charts/area-chart.tsx`
- `BarChart.tsx` → `components/charts/bar-chart.tsx`
- `Tracker.tsx` → `components/charts/tracker.tsx`

每个文件顶部加 `"use client";` 并把任何 `@/lib/utils` 风格的导入对齐到本项目:

```tsx
"use client";
import { cn } from "@/lib/utils";
```

如果 Tremor 内部用了 `chartColors` 之类的 helper,把它内联到对应文件顶部(不要新建 utils 文件,YAGNI)。

- [x] **Step 3: typecheck**

```bash
pnpm typecheck 2>&1 | tail -20
```

Expected: 0。常见报错:
- `Cannot find module "recharts"` → Step 1 没生效,重新 `pnpm install`
- Tremor 内部用了 `@radix-ui/react-icons` 而项目没有 → 把对应图标换成 `lucide-react` 版

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add package.json pnpm-lock.yaml components/charts/
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(charts): add Recharts dependency + Tremor Raw copy-in (4 components)

Tremor Raw is source-only by design. Components live under
components/charts/ next to ui/. Recharts is the only new runtime
dep — bundle impact validated at end of Phase 4 / Phase 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: format-delta 纯函数 + 测试

**Files:**
- Create: `components/features/dashboard/format-delta.ts`
- Test: `tests/unit/features/format-delta.test.ts`

- [x] **Step 1: 写测试**

Create `tests/unit/features/format-delta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatDelta } from "@/components/features/dashboard/format-delta";

describe("formatDelta", () => {
  it("returns null when previous is 0 and current is 0", () => {
    expect(formatDelta(0, 0)).toEqual(null);
  });

  it("returns +∞ marker when previous is 0 and current > 0", () => {
    expect(formatDelta(10, 0)).toEqual({ direction: "up", pct: Infinity, label: "—" });
  });

  it("computes positive delta correctly", () => {
    expect(formatDelta(120, 100)).toEqual({ direction: "up", pct: 20, label: "+20.0%" });
  });

  it("computes negative delta correctly", () => {
    expect(formatDelta(80, 100)).toEqual({ direction: "down", pct: 20, label: "-20.0%" });
  });

  it("returns flat when previous and current are equal", () => {
    expect(formatDelta(100, 100)).toEqual({ direction: "flat", pct: 0, label: "0.0%" });
  });

  it("rounds to 1 decimal", () => {
    expect(formatDelta(101, 100)).toEqual({ direction: "up", pct: 1, label: "+1.0%" });
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm test tests/unit/features/format-delta.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found。

- [x] **Step 3: 实现 formatDelta**

Create `components/features/dashboard/format-delta.ts`:

```ts
// components/features/dashboard/format-delta.ts
//
// KPI delta 计算。设计点:
//   - prev=0, curr=0 → null (无可比性,不显示 badge)
//   - prev=0, curr>0 → +∞ (UI 显示 "—" 字符)
//   - 其余 → 百分比四舍五入到 1 位小数

export interface DeltaResult {
  direction: "up" | "down" | "flat";
  pct: number; // 绝对值
  label: string; // 显示文案
}

export function formatDelta(current: number, previous: number): DeltaResult | null {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) {
    return { direction: "up", pct: Infinity, label: "—" };
  }
  const diff = current - previous;
  const pct = Math.abs((diff / previous) * 100);
  const rounded = Math.round(pct * 10) / 10;
  if (diff === 0) return { direction: "flat", pct: 0, label: "0.0%" };
  return {
    direction: diff > 0 ? "up" : "down",
    pct: rounded,
    label: `${diff > 0 ? "+" : "-"}${rounded.toFixed(1)}%`,
  };
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm test tests/unit/features/format-delta.test.ts 2>&1 | tail -10
```

Expected: 6/6 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/features/dashboard/format-delta.ts tests/unit/features/format-delta.test.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(dashboard): add formatDelta helper for KPI delta badges

Pure function, handles zero-previous edge cases. Used by KpiCard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.3: KpiCard 组件

**Files:**
- Create: `components/features/dashboard/kpi-card.tsx`
- Test: `tests/unit/features/kpi-card.test.tsx`

- [x] **Step 1: 写测试**

Create `tests/unit/features/kpi-card.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { KpiCard } from "@/components/features/dashboard/kpi-card";

describe("KpiCard", () => {
  it("renders label and value", () => {
    render(<KpiCard label="活跃分享" value="12" />);
    expect(screen.getByText("活跃分享")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("shows up delta with success color", () => {
    render(
      <KpiCard
        label="30 天操作"
        value="1,247"
        delta={{ direction: "up", pct: 12, label: "+12.0%" }}
      />,
    );
    const badge = screen.getByText("+12.0%");
    expect(badge.className).toMatch(/text-success|bg-success/);
  });

  it("shows down delta with danger color", () => {
    render(
      <KpiCard
        label="出口"
        value="87"
        delta={{ direction: "down", pct: 4, label: "-4.0%" }}
      />,
    );
    const badge = screen.getByText("-4.0%");
    expect(badge.className).toMatch(/text-destructive|bg-destructive/);
  });

  it("renders hint when provided", () => {
    render(<KpiCard label="活跃分享" value="12" hint="3 个 7 天内过期" />);
    expect(screen.getByText("3 个 7 天内过期")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm test tests/unit/features/kpi-card.test.tsx 2>&1 | tail -10
```

Expected: FAIL — module not found。

- [x] **Step 3: 实现 KpiCard**

Create `components/features/dashboard/kpi-card.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";

import type { DeltaResult } from "@/components/features/dashboard/format-delta";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  delta?: DeltaResult | null;
  hint?: string;
}

export function KpiCard({ label, value, delta, hint }: KpiCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-xs">
      <p className="text-xs tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {delta ? <DeltaBadge delta={delta} /> : null}
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

function DeltaBadge({ delta }: { delta: DeltaResult }) {
  const Icon =
    delta.direction === "up" ? ArrowUp : delta.direction === "down" ? ArrowDown : ArrowRight;
  const color =
    delta.direction === "up"
      ? "text-success bg-success/10"
      : delta.direction === "down"
      ? "text-destructive bg-destructive/10"
      : "text-muted-foreground bg-muted";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium", color)}>
      <Icon className="h-3 w-3" strokeWidth={2} />
      {delta.label}
    </span>
  );
}
```

注:`text-success` / `bg-success/10` 需要 globals.css 的 `@theme inline` 已经把 `--color-success` 映射好。如果当前桥接没有 `--color-success`,需在 `@theme inline` 块加:

```css
--color-success: var(--success);
```

(读 `app/globals.css` 确认;如果已有就跳过。)

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm test tests/unit/features/kpi-card.test.tsx 2>&1 | tail -10
```

Expected: 4/4 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add components/features/dashboard/kpi-card.tsx tests/unit/features/kpi-card.test.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(dashboard): add KpiCard with delta badge

Used by /dashboard for the four-up KPI row. Delta direction drives
the badge color; up=success, down=destructive, flat=muted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.4: RangeToggle 组件

**Files:**
- Create: `components/features/dashboard/range-toggle.tsx`

- [x] **Step 1: 实现 RangeToggle**

Create `components/features/dashboard/range-toggle.tsx`:

```tsx
"use client";

import { cn } from "@/lib/utils";

const T = {
  range7d: "7 天",
  range30d: "30 天",
} as const;

export type DashboardRange = "7d" | "30d";

interface RangeToggleProps {
  value: DashboardRange;
  onChange: (next: DashboardRange) => void;
}

export function RangeToggle({ value, onChange }: RangeToggleProps) {
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("7d")}
        className={cn(
          "rounded-sm px-3 py-1 transition-colors",
          value === "7d" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "7d"}
      >
        {T.range7d}
      </button>
      <button
        type="button"
        onClick={() => onChange("30d")}
        className={cn(
          "rounded-sm px-3 py-1 transition-colors",
          value === "30d" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "30d"}
      >
        {T.range30d}
      </button>
    </div>
  );
}
```

- [x] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add components/features/dashboard/range-toggle.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(dashboard): add 7d/30d range toggle

Used by /dashboard header to switch the time window for charts +
the "30天/7天 操作" KPI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.5: OpsAreaChart 与 OpsByTypeBar

**Files:**
- Create: `components/features/dashboard/ops-area-chart.tsx`
- Create: `components/features/dashboard/ops-by-type-bar.tsx`

- [x] **Step 1: 实现 OpsAreaChart(Tremor 包装)**

Create `components/features/dashboard/ops-area-chart.tsx`:

```tsx
"use client";

import { AreaChart } from "@/components/charts/area-chart";

interface OpsAreaChartProps {
  data: Array<{ date: string; count: number }>;
}

export function OpsAreaChart({ data }: OpsAreaChartProps) {
  return (
    <AreaChart
      data={data}
      index="date"
      categories={["count"]}
      colors={["primary"]}
      showLegend={false}
      yAxisWidth={40}
      className="h-[180px]"
    />
  );
}
```

(具体 prop 名以 Tremor Raw 源码为准 — 如果不同,在本 task 内调整。Tremor 通常用 `index` 指定 x 轴字段,`categories` 列出 y 字段。)

- [x] **Step 2: 实现 OpsByTypeBar(横向 progress bar)**

Create `components/features/dashboard/ops-by-type-bar.tsx`:

```tsx
"use client";

interface OpsByTypeBarProps {
  data: Array<{ op: string; count: number }>;
}

const OP_COLOR: Record<string, string> = {
  "upload.create": "bg-primary",
  "upload.complete": "bg-primary",
  "object.delete": "bg-destructive",
  "share.create": "bg-success",
  "share.delete": "bg-warning",
  "presign.put": "bg-primary",
  "presign.get": "bg-info",
  "connection.create": "bg-success",
  "connection.delete": "bg-destructive",
  "auth.login": "bg-muted",
  "auth.logout": "bg-muted",
};

function colorOf(op: string): string {
  return OP_COLOR[op] ?? "bg-muted";
}

export function OpsByTypeBar({ data }: OpsByTypeBarProps) {
  const max = data.reduce((m, d) => Math.max(m, d.count), 0) || 1;
  if (data.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无数据</p>;
  }
  return (
    <ul className="space-y-2 text-xs">
      {data.map((row) => (
        <li key={row.op}>
          <div className="flex items-center justify-between">
            <span className="truncate font-mono text-xs">{row.op}</span>
            <span className="font-mono text-muted-foreground tabular-nums">{row.count}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${colorOf(row.op)}`}
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
```

注:这里没用 Tremor BarChart,而是手写 progress bar — 对"操作类型分布"这种 1D 排序数据更轻、更好读。Tremor BarChart 的源码还是被 copy 进 `components/charts/`,后续如果有别的图表需要可以直接用。

- [x] **Step 3: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 0。如果 Tremor `AreaChart` 的 prop 类型与上面有出入,以源码为准更正。

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add components/features/dashboard/ops-area-chart.tsx components/features/dashboard/ops-by-type-bar.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(dashboard): add ops chart components (area + by-type bars)

OpsAreaChart wraps Tremor AreaChart; OpsByTypeBar is a hand-rolled
1D progress-bar list because it reads better than a vertical chart
for ~6 sortable ops.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.6: RecentActivity 组件

**Files:**
- Create: `components/features/dashboard/recent-activity.tsx`

- [x] **Step 1: 实现 RecentActivity**

Create `components/features/dashboard/recent-activity.tsx`:

```tsx
"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";
import type { AuditEntry } from "@/lib/api/types";

const T = {
  title: "最近活动",
  viewAll: "查看全部",
  empty: "暂无记录",
} as const;

interface RecentActivityProps {
  rows: AuditEntry[];
}

export function RecentActivity({ rows }: RecentActivityProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-xs">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{T.title}</h2>
        <Link href="/audit" className="text-xs text-primary hover:underline">
          {T.viewAll} →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{T.empty}</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {rows.map((row) => (
            <li key={row.id} className="grid grid-cols-[80px_120px_1fr_auto] items-center gap-2">
              <span className="text-muted-foreground">{formatRelative(new Date(row.createdAt))}</span>
              <Badge variant={row.status === "success" ? "secondary" : "destructive"} className="justify-self-start font-mono text-[10px]">
                {row.op}
              </Badge>
              <span className="truncate font-mono text-foreground" title={`${row.bucket ?? ""} / ${row.key ?? ""}`}>
                {row.bucket ? `${row.bucket} / ` : ""}
                {row.key ?? "—"}
              </span>
              <span className="text-muted-foreground">{row.bucket ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [x] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add components/features/dashboard/recent-activity.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(dashboard): add RecentActivity component

Compact audit row list for the dashboard home, with "查看全部 →"
deeplink to /audit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.7: Bundle 体积验证

- [x] **Step 1: build**

```bash
pnpm build:pages 2>&1 | tail -10
```

Expected: 成功。

- [x] **Step 2: 检查 worker.js 体积**

```bash
ls -lh /root/code/prisim-r2/.vercel/output/static/_worker.js | awk '{print $5}'
```

Expected: < 1MB。比 Phase 1 基线多几十 KB(Recharts 的代码主要落在 dashboard chunk,如果 Next.js 自动拆 chunk,_worker.js 增加有限)。

如果超过 1MB:
1. 把 `app/(dashboard)/dashboard/page.tsx` 准备改为 `next/dynamic` 导入 OpsAreaChart(Phase 5 时一并做)
2. 现在不一定要立刻改,Phase 5 完成后再 build 一次决定

- [x] **Step 3: Phase 4 验收**

```bash
pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -10
```

Expected: 全绿。

---

## Phase 5 · 仪表盘 API + 首页内容

> 目标:实现 `/api/dashboard/summary` 路由,新增对应限流 bundle / schema / type / hook,把 `/dashboard/page.tsx` 从 placeholder 替换为实数据 UI。

### Task 5.1: 限流 bundle

**Files:**
- Modify: `lib/api/rate-limit.ts`
- Test: 沿用 `tests/unit/api/rate-limit.test.ts`(如已存在则补一项 assertion;不存在则新加)

- [x] **Step 1: 加 policy + bundle**

Edit `lib/api/rate-limit.ts`,在 `RateLimitPolicies` 对象中追加:

```ts
dashboardSummaryByUser: (userId: string) => ({
  key: `dashboard:summary:${userId}`,
  limit: 60,
  windowMs: MIN_MS,
}),
```

在 `RateLimitBundles` 对象中追加:

```ts
dashboardSummaryByUser: (userId: string): RateLimitPolicy[] => [
  RateLimitPolicies.dashboardSummaryByUser(userId),
],
```

- [x] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add lib/api/rate-limit.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(api): add dashboardSummaryByUser rate-limit (60/min/user)

GET /api/dashboard/summary fan-outs 6 D1 queries per call; the 60/min
bucket caps the cost without throttling normal interactive use.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: Schemas / Types

**Files:**
- Modify: `lib/api/schemas.ts`(追加 DashboardSummaryQuerySchema)
- Modify: `lib/api/types.ts`(追加 DashboardSummary)

- [x] **Step 1: 在 schemas.ts 末尾追加**

```ts
/* ─── dashboard summary ─────────────────────────────────────── */

export const DashboardSummaryQuerySchema = z.object({
  connectionId: UlidSchema,
  range: z.enum(["7d", "30d"]).default("30d"),
});
export type DashboardSummaryQuery = z.infer<typeof DashboardSummaryQuerySchema>;
```

- [x] **Step 2: 在 types.ts 末尾追加**

```ts
import type { AuditEntry } from "./types"; // 已存在,如果同文件可略

/**
 * Public projection of GET /api/dashboard/summary.
 *
 *   - `bucketsCount` — number of R2 buckets in the active connection.
 *   - `shares` — active share count + 7d-expiring subcount.
 *   - `ops` — total audit ops within range + delta vs previous equal-length window.
 *   - `failures` — count of failed ops within range + failure rate %.
 *   - `opsByDay` — daily aggregate, YYYY-MM-DD keys, length matches range (7 or 30).
 *   - `opsByType` — 7d op breakdown, descending by count.
 *   - `recentActivity` — last 10 audit rows.
 */
export interface DashboardSummary {
  bucketsCount: number;
  shares: { active: number; expiring7d: number };
  ops: { count: number; previousCount: number };
  failures: { count: number; ratePct: number };
  opsByDay: Array<{ date: string; count: number }>;
  opsByType: Array<{ op: string; count: number }>;
  recentActivity: AuditEntry[];
}
```

注:`ops` 返回 `{ count, previousCount }` 而不是 `{ count, deltaPct }` — 前端直接用 `formatDelta(curr, prev)`,反推 prev 会引入浮点误差。

- [x] **Step 3: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add lib/api/schemas.ts lib/api/types.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(api): add DashboardSummary schema + type

Wire contract for GET /api/dashboard/summary. Range is enum, connection
is ULID-validated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3: lib/dashboard/summary.ts(server-only,6 queries 并发)

**Files:**
- Create: `lib/dashboard/summary.ts`
- Test: `tests/unit/dashboard/summary.test.ts`

- [x] **Step 1: 写失败测试**

Create `tests/unit/dashboard/summary.test.ts`:

```ts
// tests/unit/dashboard/summary.test.ts
//
// Integration: real better-sqlite3 backing drizzle, populate audit_log
// + shares with known rows, call getDashboardSummary, assert numbers.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import { getDashboardSummary } from "@/lib/dashboard/summary";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");

let sqlite: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzleSqlite>;
const userId = ulid();
const connectionId = ulid();

function applyMigrations() {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    sqlite.exec(sql);
  }
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzleSqlite(sqlite, { schema: realSchema });
  applyMigrations();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, "u@x", "h", Math.floor(Date.now() / 1000));
  sqlite.prepare(
    "INSERT INTO connections (id, user_id, name, account_id, endpoint, access_key_masked, access_key_ciphertext, access_key_iv, secret_key_ciphertext, secret_key_iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(connectionId, userId, "prod-main", "x", "y", "z", Buffer.alloc(1), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(12), Math.floor(Date.now() / 1000));
});

describe("getDashboardSummary", () => {
  it("empty audit log → zeros", async () => {
    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 5 },
    );
    expect(summary.bucketsCount).toBe(5);
    expect(summary.ops.count).toBe(0);
    expect(summary.failures.count).toBe(0);
    expect(summary.opsByDay).toHaveLength(30);
    expect(summary.opsByType).toEqual([]);
    expect(summary.recentActivity).toEqual([]);
  });

  it("counts ops within range, excludes older rows", async () => {
    const now = Date.now();
    const insert = sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, connection_id, op, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // 3 rows within last 30d
    for (let i = 0; i < 3; i++) {
      insert.run(ulid(), userId, connectionId, "upload.create", "success", Math.floor((now - 86_400_000) / 1000));
    }
    // 1 row 40 days ago (out of range)
    insert.run(ulid(), userId, connectionId, "upload.create", "success", Math.floor((now - 40 * 86_400_000) / 1000));

    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.ops.count).toBe(3);
  });

  it("counts failures separately", async () => {
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, connection_id, op, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(ulid(), userId, connectionId, "object.delete", "success", now);
    insert.run(ulid(), userId, connectionId, "object.delete", "failure", now);
    insert.run(ulid(), userId, connectionId, "object.delete", "failure", now);

    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.ops.count).toBe(3);
    expect(summary.failures.count).toBe(2);
    expect(summary.failures.ratePct).toBeCloseTo((2 / 3) * 100, 1);
  });

  it("opsByType orders descending", async () => {
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, connection_id, op, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 5; i++) insert.run(ulid(), userId, connectionId, "upload.create", "success", now);
    for (let i = 0; i < 2; i++) insert.run(ulid(), userId, connectionId, "object.delete", "success", now);
    for (let i = 0; i < 9; i++) insert.run(ulid(), userId, connectionId, "presign.get", "success", now);

    const summary = await getDashboardSummary(
      { connectionId, range: "7d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.opsByType[0]).toEqual({ op: "presign.get", count: 9 });
    expect(summary.opsByType[1]).toEqual({ op: "upload.create", count: 5 });
    expect(summary.opsByType[2]).toEqual({ op: "object.delete", count: 2 });
  });

  it("shares counts active + expiring within 7d", async () => {
    const now = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO shares (id, user_id, connection_id, bucket, object_key, url_hash, ttl_seconds, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // expires in 3 days → counts active + expiring7d
    insert.run(ulid(), userId, connectionId, "b", "k", "h", 3600, now + 3 * 86400, now);
    // expires in 10 days → active, NOT expiring7d
    insert.run(ulid(), userId, connectionId, "b", "k2", "h", 3600, now + 10 * 86400, now);
    // already expired
    insert.run(ulid(), userId, connectionId, "b", "k3", "h", 3600, now - 86400, now - 86400 * 2);

    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.shares.active).toBe(2);
    expect(summary.shares.expiring7d).toBe(1);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm test tests/unit/dashboard/summary.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found。

- [x] **Step 3: 实现 lib/dashboard/summary.ts**

Create `lib/dashboard/summary.ts`:

```ts
// lib/dashboard/summary.ts
//
// 6 D1 queries 并发, 组装 DashboardSummary.
//
// 注意:此处不直接读 R2 bucketsCount(R2 list bucket 是个外部 SDK call;
// 在 edge route 中已通过 listBuckets cached query 拿到), 因此调用者
// 在 route 中传入 bucketsCount。

import "server-only";

import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { schema } from "@/lib/db/schema";
import type { DashboardSummary } from "@/lib/api/types";
import type { AuditEntry } from "@/lib/api/types";

interface SummaryDeps {
  db: ReturnType<typeof import("drizzle-orm/d1").drizzle> | ReturnType<typeof import("drizzle-orm/better-sqlite3").drizzle>;
  userId: string;
  bucketsCount: number;
}

interface SummaryInput {
  connectionId: string;
  range: "7d" | "30d";
}

function daysOf(range: "7d" | "30d"): number {
  return range === "7d" ? 7 : 30;
}

export async function getDashboardSummary(
  input: SummaryInput,
  deps: SummaryDeps,
): Promise<DashboardSummary> {
  const { db, userId, bucketsCount } = deps;
  const { connectionId, range } = input;
  const days = daysOf(range);
  const now = new Date();
  const rangeStart = new Date(now.getTime() - days * 86_400_000);
  const prevStart = new Date(now.getTime() - 2 * days * 86_400_000);
  const expiring7dDeadline = new Date(now.getTime() + 7 * 86_400_000);

  const [
    opsTotal,
    opsPrev,
    failuresTotal,
    sharesAggregate,
    opsByTypeRows,
    opsByDayRows,
    recentRows,
  ] = await Promise.all([
    // 1. current-window ops
    db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, rangeStart),
        ),
      ),
    // 2. previous-window ops (for delta)
    db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, prevStart),
          sql`${schema.auditLog.createdAt} < ${rangeStart}`,
        ),
      ),
    // 3. failures in current window
    db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          eq(schema.auditLog.status, "failure"),
          gte(schema.auditLog.createdAt, rangeStart),
        ),
      ),
    // 4. shares aggregate
    db
      .select({
        active: sql<number>`SUM(CASE WHEN ${schema.shares.expiresAt} > ${now} THEN 1 ELSE 0 END)`,
        expiring7d: sql<number>`SUM(CASE WHEN ${schema.shares.expiresAt} > ${now} AND ${schema.shares.expiresAt} <= ${expiring7dDeadline} THEN 1 ELSE 0 END)`,
      })
      .from(schema.shares)
      .where(eq(schema.shares.userId, userId)),
    // 5. ops by type (7d window for the chart, regardless of selected range)
    db
      .select({ op: schema.auditLog.op, n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, new Date(now.getTime() - 7 * 86_400_000)),
        ),
      )
      .groupBy(schema.auditLog.op),
    // 6. ops by day
    db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', datetime(${schema.auditLog.createdAt}, 'unixepoch'))`,
        n: count(),
      })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, rangeStart),
        ),
      )
      .groupBy(sql`strftime('%Y-%m-%d', datetime(${schema.auditLog.createdAt}, 'unixepoch'))`),
    // 7. recent rows (the 7th query — counts as one of the "6 parallel" for our
    //    purposes; spec said "6 queries" but include this since it's small)
    db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(10),
  ]);

  const currentOps = opsTotal[0]?.n ?? 0;
  const prevOps = opsPrev[0]?.n ?? 0;

  const failuresN = failuresTotal[0]?.n ?? 0;
  const ratePct = currentOps === 0 ? 0 : (failuresN / currentOps) * 100;

  // pad opsByDay to exactly `days` slots
  const opsByDayMap = new Map(opsByDayRows.map((r) => [r.day, r.n]));
  const opsByDay: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const dayKey = d.toISOString().slice(0, 10);
    opsByDay.push({ date: dayKey, count: opsByDayMap.get(dayKey) ?? 0 });
  }

  const opsByType = opsByTypeRows
    .map((r) => ({ op: r.op, count: r.n }))
    .sort((a, b) => b.count - a.count);

  const recentActivity: AuditEntry[] = recentRows.map((r) => ({
    id: r.id,
    op: r.op,
    status: (r.status as "success" | "failure") ?? "success",
    bucket: r.bucket,
    key: r.objectKey,
    connectionId: r.connectionId,
    errorMsg: r.errorMsg,
    ip: r.ip,
    ua: r.ua,
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt) * 1000,
  }));

  return {
    bucketsCount,
    shares: {
      active: Number(sharesAggregate[0]?.active ?? 0),
      expiring7d: Number(sharesAggregate[0]?.expiring7d ?? 0),
    },
    ops: {
      count: currentOps,
      previousCount: prevOps,
    },
    failures: {
      count: failuresN,
      ratePct,
    },
    opsByDay,
    opsByType,
    recentActivity,
  };
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm test tests/unit/dashboard/summary.test.ts 2>&1 | tail -15
```

Expected: 5/5 PASS。如果有 query 写法错误(drizzle SQL 拼装、bind 顺序),逐条修。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add lib/dashboard/summary.ts tests/unit/dashboard/summary.test.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(api): add getDashboardSummary (6 D1 queries parallel)

Pure server-only function — route handler injects (db, userId,
bucketsCount). bucketsCount comes from /api/r2/buckets cached on the
client side; this function only handles D1-derived numbers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.4: app/api/dashboard/summary/route.ts

**Files:**
- Create: `app/api/dashboard/summary/route.ts`
- Test: `tests/unit/api/dashboard-summary-route.test.ts`

- [x] **Step 1: 写失败测试**

Create `tests/unit/api/dashboard-summary-route.test.ts`,基于现有 `tests/unit/api/audit-route.test.ts` 的同样 mock 套路 (`getRequestContext` / `getDb` / 假 session)。

骨架:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import { ApiErrorCode } from "@/lib/api/errors";

const AUTH_SECRET = "dashboard-summary-test-secret";
const userId = ulid();
const connectionId = ulid();

let sqlite: InstanceType<typeof Database>;
let drizzleDb: ReturnType<typeof drizzleSqlite>;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const sessionStore = new Map<string, { csrfTokenHash: string | null; userId: string; email: string }>();

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => fakeJwt.token) }));
vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: () => ({ env: { DB: sqlite, AUTH_SECRET } }),
}));
vi.mock("@/lib/db/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
  return { ...actual, getDb: () => drizzleDb };
});
vi.mock("@/lib/auth/adapter", () => ({
  createD1Adapter: () => ({
    async getSessionAndUser(token: string) {
      const s = sessionStore.get(token);
      if (!s) return null;
      return { user: { id: s.userId, email: s.email }, expiresAt: new Date(Date.now() + 3600_000) };
    },
  }),
}));
// stub R2 list buckets — route uses a helper; mock that helper directly
vi.mock("@/lib/r2/control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/r2/control")>("@/lib/r2/control");
  return { ...actual, listBuckets: vi.fn(async () => [{ name: "b1", createdAt: new Date() }, { name: "b2", createdAt: new Date() }]) };
});

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");
function applyMigrations() {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    sqlite.exec(sql);
  }
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  applyMigrations();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)").run(userId, "u@x", "h", Math.floor(Date.now()/1000));
  sqlite.prepare("INSERT INTO connections (id, user_id, name, account_id, endpoint, access_key_masked, access_key_ciphertext, access_key_iv, secret_key_ciphertext, secret_key_iv, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(connectionId, userId, "prod-main", "x", "y", "z", Buffer.alloc(1), Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(12), Math.floor(Date.now()/1000));
  fakeJwt.token = { userId, sessionToken: "tok", csrfToken: "csrf" };
  sessionStore.set("tok", { csrfTokenHash: null, userId, email: "u@x" });
});

describe("GET /api/dashboard/summary", () => {
  it("happy path returns DashboardSummary shape", async () => {
    const { GET } = await import("@/app/api/dashboard/summary/route");
    const req = new Request(`http://localhost/api/dashboard/summary?connectionId=${connectionId}&range=7d`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("bucketsCount");
    expect(body).toHaveProperty("ops");
    expect(body).toHaveProperty("opsByDay");
    expect(body.opsByDay).toHaveLength(7);
  });

  it("unauthenticated → 401", async () => {
    fakeJwt.token = null;
    sessionStore.clear();
    const { GET } = await import("@/app/api/dashboard/summary/route");
    const req = new Request(`http://localhost/api/dashboard/summary?connectionId=${connectionId}&range=30d`);
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("invalid range → 400 validation.invalid", async () => {
    const { GET } = await import("@/app/api/dashboard/summary/route");
    const req = new Request(`http://localhost/api/dashboard/summary?connectionId=${connectionId}&range=90d`);
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ApiErrorCode.ValidationInvalid);
  });

  it("missing connectionId → 400", async () => {
    const { GET } = await import("@/app/api/dashboard/summary/route");
    const req = new Request(`http://localhost/api/dashboard/summary?range=7d`);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm test tests/unit/api/dashboard-summary-route.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found。

- [x] **Step 3: 实现 route**

Create `app/api/dashboard/summary/route.ts`:

```ts
// app/api/dashboard/summary/route.ts
//
// GET /api/dashboard/summary?connectionId=<ULID>&range=7d|30d
// Returns DashboardSummary. Read-only — uses CSRF-exempt GET.

import "server-only";

import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { parseQuery, DashboardSummaryQuerySchema } from "@/lib/api/schemas";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { getDb } from "@/lib/db/client";
import { listBuckets, decryptConnectionCredentials } from "@/lib/r2/control";
import { getConnection } from "@/lib/connections/get";
import { getDashboardSummary } from "@/lib/dashboard/summary";

export const runtime = "edge";

export const GET = withApi(
  async (req, ctx) => {
    const input = await parseQuery(req, DashboardSummaryQuerySchema);

    const env = getRequestContext().env as { DB: D1Database; ENCRYPTION_KEY: string };
    const db = getDb({ DB: env.DB });

    // Verify the connection belongs to this user (the JOIN in summary's
    // queries also enforces this, but we want a clean 404 / 403 if the
    // ULID is from another user).
    const conn = await getConnection(db, ctx.userId, input.connectionId);

    // bucketsCount: list buckets from R2 (control-plane call).
    const credentials = await decryptConnectionCredentials(conn, env.ENCRYPTION_KEY);
    const buckets = await listBuckets({
      accountId: conn.accountId,
      ...credentials,
    });

    return getDashboardSummary(input, {
      db,
      userId: ctx.userId,
      bucketsCount: buckets.length,
    });
  },
  { rateLimit: ({ ctx }) => RateLimitBundles.dashboardSummaryByUser(ctx.userId) },
);
```

注意:`lib/connections/get.ts`、`decryptConnectionCredentials` 是已有 helper(spec 内 R2 调用走的是 lib/r2/control.ts)。如果具体函数名/导出有差异,以现有代码为准——查 `lib/r2/control.ts` 与 `lib/connections/` 的 export 调整 import。

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm test tests/unit/api/dashboard-summary-route.test.ts 2>&1 | tail -15
```

Expected: 4/4 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add app/api/dashboard/summary/route.ts tests/unit/api/dashboard-summary-route.test.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(api): GET /api/dashboard/summary

Wires withApi + Zod + dashboardSummaryByUser limit + getDashboardSummary.
listBuckets is the only non-D1 call; everything else hits D1 in a
6-query parallel fan-out.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.5: hooks/use-dashboard.ts

**Files:**
- Create: `hooks/use-dashboard.ts`

- [x] **Step 1: 实现 hook**

Create `hooks/use-dashboard.ts`:

```ts
// hooks/use-dashboard.ts
//
// TanStack Query hook for GET /api/dashboard/summary.

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/client";
import type { DashboardSummary } from "@/lib/api/types";

export const DASHBOARD_QUERY_KEY = (connectionId: string | null, range: "7d" | "30d") =>
  ["dashboard", connectionId, range] as const;

export function useDashboardSummary(connectionId: string | null, range: "7d" | "30d") {
  return useQuery({
    queryKey: DASHBOARD_QUERY_KEY(connectionId, range),
    queryFn: async () => {
      if (!connectionId) throw new Error("no connection");
      return apiFetch<DashboardSummary>(
        `/api/dashboard/summary?connectionId=${connectionId}&range=${range}`,
      );
    },
    enabled: !!connectionId,
    staleTime: 30_000,
  });
}
```

- [x] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 3: 提交**

```bash
git -C /root/code/prisim-r2 add hooks/use-dashboard.ts
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(hooks): add useDashboardSummary

Disabled when no active connection. 30s staleTime matches the rest
of the app's read cadence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.6: /dashboard/page.tsx 全新内容

**Files:**
- Modify: `app/(dashboard)/dashboard/page.tsx`(整体重写)

- [x] **Step 1: 重写 dashboard page**

Replace contents of `app/(dashboard)/dashboard/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { useDashboardSummary } from "@/hooks/use-dashboard";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { KpiCard } from "@/components/features/dashboard/kpi-card";
import { OpsAreaChart } from "@/components/features/dashboard/ops-area-chart";
import { OpsByTypeBar } from "@/components/features/dashboard/ops-by-type-bar";
import { RecentActivity } from "@/components/features/dashboard/recent-activity";
import { RangeToggle, type DashboardRange } from "@/components/features/dashboard/range-toggle";
import { formatDelta } from "@/components/features/dashboard/format-delta";

const T = {
  title: "仪表盘",
  subTitle: (conn: string, buckets: number) => `${conn} · ${buckets} 个 Bucket`,
  noConn: "请先在顶栏选择一个连接",
  loading: "加载中…",
  loadError: "无法加载仪表盘数据",
  kpiBuckets: "Bucket 数",
  kpiShares: "活跃分享",
  shareExpiring: (n: number) => `${n} 个 7 天内过期`,
  kpiOps: (range: DashboardRange) => `${range === "7d" ? "7" : "30"} 天操作`,
  kpiFailures: (range: DashboardRange) => `${range === "7d" ? "7" : "30"} 天失败率`,
  chartArea: (range: DashboardRange) => `操作量 · ${range === "7d" ? "7" : "30"} 天`,
  chartBars: "操作类型 · 7 天",
} as const;

export default function DashboardPage() {
  const activeId = useActiveConnectionStore((s) => s.activeConnectionId);
  const [range, setRange] = useState<DashboardRange>("30d");

  const { data, isPending, isError, error } = useDashboardSummary(activeId, range);

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {T.noConn}
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {T.loading}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <p>{T.loadError}</p>
        <p className="font-mono text-xs text-destructive/80">{error.message}</p>
      </div>
    );
  }

  const opsDelta = formatDelta(data.ops.count, data.ops.previousCount);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {T.subTitle("当前连接", data.bucketsCount)}
          </p>
        </div>
        <RangeToggle value={range} onChange={setRange} />
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={T.kpiBuckets} value={data.bucketsCount.toLocaleString()} />
        <KpiCard
          label={T.kpiShares}
          value={data.shares.active.toLocaleString()}
          hint={data.shares.expiring7d > 0 ? T.shareExpiring(data.shares.expiring7d) : undefined}
        />
        <KpiCard
          label={T.kpiOps(range)}
          value={data.ops.count.toLocaleString()}
          delta={opsDelta}
        />
        <KpiCard
          label={T.kpiFailures(range)}
          value={`${data.failures.ratePct.toFixed(2)}%`}
          hint={`共 ${data.failures.count} 次`}
        />
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4 shadow-xs lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">{T.chartArea(range)}</h2>
          <OpsAreaChart data={data.opsByDay} />
        </div>
        <div className="rounded-lg border border-border bg-card p-4 shadow-xs">
          <h2 className="mb-3 text-sm font-semibold">{T.chartBars}</h2>
          <OpsByTypeBar data={data.opsByType} />
        </div>
      </section>

      <RecentActivity rows={data.recentActivity} />
    </div>
  );
}
```

(清理 `useActiveConnectionStore.getState; // unused noise` 那行)

- [x] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 0。

- [x] **Step 3: 启动 preview 手动验证**

```bash
pnpm preview
```

登录 → 选连接 → 进 `/dashboard`,确认:
- 4 张 KPI 卡渲染,delta badge 出现
- AreaChart 渲染 30 天柱
- 7 天操作分布柱状渲染
- 最近活动 10 行显示
- 切换 7d / 30d,KPI label 与图表变化
- 切主题(蓝/橙/绿,亮/暗)无视觉硬伤

Stop preview。

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add app/\(dashboard\)/dashboard/page.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(dashboard): replace placeholder with real KPI + charts page

Renders 4 KPI cards (buckets/shares/ops/failures), an area chart of
ops per day, a bar list of ops by type (7d), and a 10-row recent
activity list — all driven by GET /api/dashboard/summary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.7: Phase 5 bundle 验收

- [x] **Step 1: build + size check**

```bash
pnpm build:pages 2>&1 | tail -10
ls -lh .vercel/output/static/_worker.js | awk '{print $5}'
```

Expected: < 1MB。如果接近 1MB,执行下一步;否则直接 Step 3。

- [x] **Step 2: 如果超 1MB,改 dynamic import**

Edit `app/(dashboard)/dashboard/page.tsx`,把 chart 组件改为 dynamic:

```tsx
import dynamic from "next/dynamic";
const OpsAreaChart = dynamic(() => import("@/components/features/dashboard/ops-area-chart").then((m) => m.OpsAreaChart), { ssr: false });
const OpsByTypeBar = dynamic(() => import("@/components/features/dashboard/ops-by-type-bar").then((m) => m.OpsByTypeBar), { ssr: false });
```

重跑 build,确认 < 1MB。提交。

- [x] **Step 3: 全套门**

```bash
pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -20
```

Expected: 全绿。

---

## Phase 6 · /buckets 卡片化

> 目标:把 `/buckets` 从占位文案改为 bucket 卡片网格。

### Task 6.1: /buckets/page.tsx 重写

**Files:**
- Modify: `app/(dashboard)/buckets/page.tsx`
- Test: `tests/unit/features/buckets-page.test.tsx`

- [x] **Step 1: 写测试**

Create `tests/unit/features/buckets-page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-buckets", () => ({ useBuckets: vi.fn() }));
vi.mock("@/stores/active-connection", () => ({ useActiveConnectionStore: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/buckets", useRouter: () => ({ push: vi.fn() }) }));

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import BucketsPage from "@/app/(dashboard)/buckets/page";

function withQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("BucketsPage", () => {
  it("shows empty state when no buckets", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({ activeConnectionId: "01" } as never);
    vi.mocked(useBuckets).mockReturnValue({ data: [], isPending: false, isError: false } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getByText(/暂无 Bucket/)).toBeInTheDocument();
  });

  it("renders one card per bucket", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({ activeConnectionId: "01" } as never);
    vi.mocked(useBuckets).mockReturnValue({
      data: [
        { name: "assets", createdAt: Date.now() },
        { name: "backups", createdAt: Date.now() },
        { name: "logs", createdAt: null },
      ],
      isPending: false,
      isError: false,
    } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getAllByRole("link", { name: /assets|backups|logs/ })).toHaveLength(3);
  });

  it("shows error state with retry", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({ activeConnectionId: "01" } as never);
    vi.mocked(useBuckets).mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("Boom"),
      refetch: vi.fn(),
    } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getByText(/无法加载/)).toBeInTheDocument();
  });

  it("prompts for connection when none active", () => {
    vi.mocked(useActiveConnectionStore).mockReturnValue({ activeConnectionId: null } as never);
    vi.mocked(useBuckets).mockReturnValue({ data: undefined, isPending: false, isError: false } as never);
    render(withQuery(<BucketsPage />));
    expect(screen.getByText(/请先在顶栏选择一个连接/)).toBeInTheDocument();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
pnpm test tests/unit/features/buckets-page.test.tsx 2>&1 | tail -10
```

Expected: FAIL — page 仍是 placeholder,没有 "暂无 Bucket" 等文案。

- [x] **Step 3: 重写 page**

Replace `app/(dashboard)/buckets/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { AlertCircle, Database, Loader2 } from "lucide-react";

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";

const T = {
  title: "存储桶",
  noConn: "请先在顶栏选择一个连接",
  empty: "暂无 Bucket",
  emptyHint: "去 Cloudflare 控制台新建 Bucket,然后回到这里。",
  loading: "加载中…",
  loadError: "无法加载存储桶列表",
  retry: "重试",
  created: (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString("zh-CN")),
  enter: "进入",
} as const;

export default function BucketsPage() {
  const activeId = useActiveConnectionStore((s) => s.activeConnectionId);
  const { data, isPending, isError, error, refetch, isFetching } = useBuckets(activeId);

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {T.noConn}
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {T.loading}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <p>{T.loadError}</p>
        <p className="font-mono text-xs text-destructive/80">{(error as Error)?.message ?? ""}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="mt-2 rounded-md border border-border bg-card px-3 py-1 text-xs hover:bg-accent"
        >
          {T.retry}
        </button>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
        <p className="font-display text-lg italic text-muted-foreground">{T.empty}</p>
        <p className="max-w-md text-xs text-muted-foreground">{T.emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{data.length} 个</p>
      </header>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data.map((bucket) => (
          <Link
            key={bucket.name}
            href={`/buckets/${encodeURIComponent(bucket.name)}`}
            className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Database className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm font-medium">{bucket.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  创建于 {T.created(bucket.createdAt)}
                </p>
              </div>
            </div>
            <p className="text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
              {T.enter} →
            </p>
          </Link>
        ))}
      </section>
    </div>
  );
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
pnpm test tests/unit/features/buckets-page.test.tsx 2>&1 | tail -10
```

Expected: 4/4 PASS。

- [x] **Step 5: 提交**

```bash
git -C /root/code/prisim-r2 add app/\(dashboard\)/buckets/page.tsx tests/unit/features/buckets-page.test.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(buckets): replace placeholder with bucket card grid

Empty / loading / error / data states; cards link to the
/buckets/[bucket]/ object browser.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.2: /settings 加 tabs

**Files:**
- Modify: `app/(dashboard)/settings/page.tsx`(加 tabs)
- 不动 `app/(dashboard)/settings/connections/page.tsx`(独立子路由继续工作)

Spec 6 提到 `/settings` 加页眉 tabs(连接管理 / 个人偏好 / 关于)。后两项 V2,本 task 只把骨架立起来,占位"敬请期待"。

- [x] **Step 1: 看现有 page**

Read `app/(dashboard)/settings/page.tsx` 了解现状(若是简单引导文案,直接重写;若已经有内容,只追加 tabs)。

- [x] **Step 2: 重写为带 tabs 的入口**

Replace `app/(dashboard)/settings/page.tsx`:

```tsx
"use client";

import Link from "next/link";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const T = {
  title: "设置",
  tabConnections: "连接管理",
  tabProfile: "个人偏好",
  tabAbout: "关于",
  manageHint: "管理 R2 连接,加密凭据存储与轮换。",
  manageCta: "去连接管理",
  v2Coming: "敬请期待",
  v2Desc: "此分区将在 V2 上线。",
} as const;

export default function SettingsPage() {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
      </header>
      <Tabs defaultValue="connections" className="flex-1">
        <TabsList>
          <TabsTrigger value="connections">{T.tabConnections}</TabsTrigger>
          <TabsTrigger value="profile">{T.tabProfile}</TabsTrigger>
          <TabsTrigger value="about">{T.tabAbout}</TabsTrigger>
        </TabsList>
        <TabsContent value="connections" className="mt-4">
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">{T.manageHint}</p>
            <Link
              href="/connections"
              className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {T.manageCta}
            </Link>
          </div>
        </TabsContent>
        <TabsContent value="profile" className="mt-4">
          <V2Placeholder />
        </TabsContent>
        <TabsContent value="about" className="mt-4">
          <V2Placeholder />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function V2Placeholder() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
      <p className="font-display text-lg italic text-muted-foreground">{T.v2Coming}</p>
      <p className="mt-1 text-xs text-muted-foreground">{T.v2Desc}</p>
    </div>
  );
}
```

`Tabs` 组件来自现有 `components/ui/tabs.tsx`(已是 shadcn 生成,无需新 add)。

- [x] **Step 3: typecheck + lint**

```bash
pnpm typecheck && pnpm lint 2>&1 | tail -5
```

Expected: 0。

- [x] **Step 4: 提交**

```bash
git -C /root/code/prisim-r2 add app/\(dashboard\)/settings/page.tsx
git -C /root/code/prisim-r2 commit -m "$(cat <<'EOF'
feat(settings): add tabs (connections / profile / about)

V1 only "连接管理" tab is wired; "个人偏好" / "关于" are V2 placeholders.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.3: 全套验收

- [x] **Step 1: 跑所有测试 + lint + typecheck**

```bash
pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -30
```

Expected: 全绿。

- [x] **Step 2: build:pages 最终核查**

```bash
pnpm build:pages 2>&1 | tail -10
ls -lh .vercel/output/static/_worker.js | awk '{print $5}'
```

Expected: < 1MB。

- [x] **Step 3: 端到端手动 smoke test**

```bash
pnpm preview
```

清单(每条目验证后打勾):
- [x] `/login` 能登录(回归)
- [x] `/dashboard` 显示 KPI + 图表 + 活动
- [x] `/buckets` 显示卡片网格
- [x] `/buckets/[bucket]` 显示对象表 + 顶栏面包屑显示完整 prefix
- [x] `/audit` 表格无回归
- [x] `/connections` 列表 + 创建/重命名/删除 dialog 无回归
- [x] `/shares` 列表无回归
- [x] `/settings` 显示 3 tabs(连接管理可点 + 子页跳转,profile/about 显示 V2 占位)
- [x] ⌘K 命令面板触发(键盘 + 顶栏胶囊)
- [x] 主题切换 蓝/橙/绿 × 亮/暗/系统 = 6 套全部生效
- [x] 折叠 / 展开侧栏正常
- [x] 顶栏面包屑切 connection / bucket 都跳路由

Stop preview。

- [x] **Step 4: Phase 6 收尾提交**

(无需要 commit,Step 3 是验收)

---

## 完工

完成 6 个 Phase 后:
- `pnpm typecheck && pnpm lint && pnpm test` 全绿
- bundle < 1MB
- 手动 smoke test 全过
- 所有 phase 各自独立 commit,`git log feat/sub-spec-1-i18n-themes-shell...HEAD` 应该看到清晰的 phase 分组

后续可考虑(本 plan 不在范围):
- `/connections?new=1` 自动打开"新建连接" dialog(对接 command menu 的"新建连接"快捷动作)
- `/settings/page.tsx` 加 tabs("连接管理 / 个人偏好 / 关于")
- bucket size / object count "按需扫描" 卡片(V2)
- CF Analytics API 接入(V2)

如果遇到 spec 文档与实际代码不一致的问题(例如 `lib/connections/get.ts` 不存在、`decryptConnectionCredentials` 名字不同),在动手前查现有 route 看它怎么调,沿用既有命名;若 spec 与实现有结构性出入,记下来 review spec。
