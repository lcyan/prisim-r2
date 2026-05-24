# Sub-spec 1 实施计划：i18n + 三主题 + 顶/侧栏对齐

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单主题英文 UI 改造为三主题中文 UI，并按设计稿对齐顶栏（Bucket 切换器）/ 侧栏（6 项 + bucket 二级常驻展开）/ 路由结构（新增 `/dashboard` `/buckets` `/settings` `/connections` 顶级路由）。不动业务逻辑。

**Architecture:**
- 主题系统：复用 `next-themes@0.4.6`（已装）+ `<ThemeProvider attribute="data-theme" themes={['blue','orange','green']} defaultTheme="blue">` + 三套 CSS 变量声明在 `:root[data-theme="…"]` + Tailwind v4 `@theme inline` 桥接 shadcn 期望的 `--color-*` token 名。
- i18n：硬编码中文 + 每个文件顶部 `const T = {...} as const` + `lib/i18n/common.ts`（公共词）+ `lib/i18n/error-messages.ts`（错误码 → 中文映射）。
- 布局：232px 侧栏 + 56px 顶栏 grid；侧栏顶部 logo + 6 项主导航（含 bucket 二级常驻展开）+ 底部活动连接卡；顶栏左侧 Bucket 切换器（在当前 connection 下）、右侧主题切换器 + 用户菜单。

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript strict · Tailwind v4 · shadcn (new-york) · Zustand 5 · next-themes 0.4.6 · Vitest + jsdom（**新增**）+ @testing-library/react（**新增**）

**Spec source:** `docs/superpowers/specs/2026-05-23-i18n-themes-shell-design.md`

---

## 文件结构

### 新建（11 个）
| # | 文件 | 职责 |
|---|---|---|
| 1 | `tests/unit/i18n/error-messages.test.ts` | error-messages 字典单测 |
| 2 | `tests/unit/dashboard/pick-home-route.test.ts` | pick-home-route 新逻辑单测 |
| 3 | `tests/unit/features/dashboard/theme-switcher.test.tsx` | theme-switcher 渲染 + 点击单测 |
| 4 | `lib/i18n/common.ts` | 公共词（取消/确认/保存/删除/复制/重试/关闭/新建/刷新） |
| 5 | `lib/i18n/error-messages.ts` | `ERROR_MESSAGES` 字典 + `describeError(code)` |
| 6 | `components/features/dashboard/theme-switcher.tsx` | 顶栏右侧主题切换 pill + popover |
| 7 | `components/features/dashboard/user-menu.tsx` | 顶栏右侧用户 pill + popover（邮箱 + 退出登录） |
| 8 | `app/(dashboard)/dashboard/page.tsx` | 仪表盘占位 |
| 9 | `app/(dashboard)/buckets/page.tsx` | 存储桶父占位 |
| 10 | `app/(dashboard)/settings/page.tsx` | 设置占位 |
| 11 | `app/(dashboard)/connections/page.tsx` | 连接管理（从 settings/connections 迁移） |

### 重写（4 个）
| # | 文件 | 变更 |
|---|---|---|
| 12 | `components/layout/app-shell.tsx` | 新网格 + 顶栏 + 侧栏（logo / 6 项主导航 / bucket 二级 / 活动连接卡） |
| 13 | `components/features/dashboard/bucket-switcher.tsx` | 替换为顶栏 bucket switcher（当前是 connection switcher 的包装） |
| 14 | `components/features/dashboard/home-redirector.tsx` | dashboard-first |
| 15 | `components/features/dashboard/pick-home-route.ts` | 改为 dashboard-first 逻辑 |

### 改文案 / token 引用 / 配置（不动业务逻辑）
| # | 文件 | 变更 |
|---|---|---|
| 16 | `app/globals.css` | 替换为三主题 token 表 + 删 `.dark` + 改字体变量为系统中文栈 |
| 17 | `app/layout.tsx` | 删 Google Fonts import、新增 next-themes Provider、`<html lang="zh-CN">` |
| 18 | `app/(auth)/login/page.tsx` | 中文化 |
| 19 | `app/(dashboard)/audit/page.tsx` | 中文化 |
| 20 | `app/(dashboard)/shares/page.tsx` | 中文化 |
| 21 | `app/(dashboard)/buckets/[bucket]/[[...prefix]]/page.tsx` | 中文化 |
| 22-26 | `components/features/connections/*.tsx` (5) | 中文化 |
| 27-30 | `components/features/files/*.tsx` (4) | 中文化 |
| 31 | `components/features/share/share-dialog.tsx` | 中文化 |
| 32-35 | `components/features/upload/*.tsx` (4) | 中文化 |
| 36-37 | `components/features/dashboard/sign-out-button.tsx`, `logo.tsx` | 中文化 |
| 38 | `vitest.config.ts` | 加 jsdom + 改 include 为 `.{ts,tsx}` |
| 39 | `package.json` | devDependency 加 `@testing-library/react` `@testing-library/jest-dom` `jsdom` |
| 40 | `app/(dashboard)/settings/connections/page.tsx` | 改为 `redirect('/connections')`（Next.js server redirect） |
| 41 | `components/providers.tsx` | 检查是否合适放 ThemeProvider（或在 app/layout.tsx）|

---

## Task 1: Vitest jsdom + testing-library 环境

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: 装依赖**

```bash
pnpm add -D @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14 jsdom@^25
```

- [ ] **Step 2: 改 `vitest.config.ts`**

替换为：

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["lib/**/*.ts"],
      exclude: ["**/*.test.ts", "**/types.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
```

- [ ] **Step 3: 写 `tests/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 4: 跑现有测试，确认无回归**

```bash
pnpm test
```

预期：所有现有测试仍通过（已有的 `tests/unit/**/*.test.ts` 应被新 include 模式匹配）。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts tests/setup.ts
git commit -m "chore(test): add jsdom + testing-library for component unit tests"
```

---

## Task 2: 三主题 token 替换 + 字体栈

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: 完全替换 `app/globals.css`**

这是一个 ~150 行的整体替换。当前文件用 oklch + 单主题，新文件用三主题。直接覆盖：

```css
@import "tailwindcss";

/*
  Prisim R2 — 三套亮色主题
  靠 <html data-theme="blue|orange|green"> 切换。next-themes 在 ThemeProvider 中
  设置 attribute="data-theme"，attribute 写到 <html> 上。
*/

:root,
:root[data-theme="blue"] {
  --primary: #1677FF;
  --primary-hover: #4391FF;
  --primary-active: #0E5FD8;
  --primary-soft: #F0F5FF;
  --primary-soft-strong: #E6EFFF;
  --primary-fg: #FFFFFF;

  --content-bg: #F5F7FA;
  --row-hover: #F7F9FC;
  --hover: rgba(22, 119, 255, 0.06);
  --info: #1677FF;
  --info-soft: #F0F5FF;

  /* 通用 token —— 在所有主题下相同 */
  --fg: #1F2329;
  --fg-2: #4E5969;
  --muted: #86909C;
  --muted-2: #C9CDD4;
  --border: #E5E6EB;
  --border-strong: #D1D5DB;
  --surface: #FFFFFF;
  --sidebar-bg: #FFFFFF;
  --topbar-bg: #FFFFFF;
  --code-bg: #F2F3F5;

  --success: #00B42A;
  --success-soft: #E8FFEA;
  --warning: #FF7D00;
  --warning-soft: #FFF7E8;
  --danger: #F53F3F;
  --danger-soft: #FFECE8;

  --radius-sm: 4px;
  --radius: 6px;
  --radius-lg: 10px;
  --radius-xl: 14px;
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
  --shadow-md: 0 4px 14px rgba(15, 23, 42, 0.08);
  --shadow-lg: 0 24px 60px rgba(15, 23, 42, 0.18);

  --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-mono: "SF Mono", "JetBrains Mono", Monaco, Menlo, Consolas,
    "Source Han Mono", monospace;

  /* 布局原语 */
  --topbar-h: 3.5rem;        /* 56px */
  --sidebar-w: 14.5rem;       /* 232px */
  --row-h-tight: 2.25rem;     /* 36px */
  --row-h: 2.5rem;            /* 40px */
}

:root[data-theme="orange"] {
  --primary: #FF6A00;
  --primary-hover: #FF8A33;
  --primary-active: #DB5A00;
  --primary-soft: #FFF7ED;
  --primary-soft-strong: #FFEAD1;
  --content-bg: #FFFBF5;
  --row-hover: #FFF7ED;
  --hover: rgba(255, 106, 0, 0.06);
  --info: #FF6A00;
  --info-soft: #FFF7ED;
}

:root[data-theme="green"] {
  --primary: #00B96B;
  --primary-hover: #2FCD8A;
  --primary-active: #009957;
  --primary-soft: #ECFDF5;
  --primary-soft-strong: #D2F7E5;
  --content-bg: #F6FEFA;
  --row-hover: #ECFDF5;
  --hover: rgba(0, 185, 107, 0.06);
  --info: #00B96B;
  --info-soft: #ECFDF5;
}

/* shadcn ↔ 设计稿 token 桥接（Tailwind v4） */
@theme inline {
  --color-background: var(--content-bg);
  --color-foreground: var(--fg);
  --color-card: var(--surface);
  --color-card-foreground: var(--fg);
  --color-popover: var(--surface);
  --color-popover-foreground: var(--fg);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-fg);
  --color-secondary: var(--primary-soft);
  --color-secondary-foreground: var(--primary);
  --color-muted: var(--row-hover);
  --color-muted-foreground: var(--muted);
  --color-accent: var(--primary-soft);
  --color-accent-foreground: var(--primary);
  --color-destructive: var(--danger);
  --color-destructive-foreground: var(--primary-fg);
  --color-border: var(--border);
  --color-input: var(--border);
  --color-ring: var(--primary);

  --radius: var(--radius);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  font-family: var(--font-sans);
  color: var(--fg);
  background: var(--content-bg);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code, .mono {
  font-family: var(--font-mono);
}

/* 侧栏活跃指示条（2px primary 色） */
.signal-bar {
  position: relative;
}
.signal-bar::before {
  content: "";
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--primary);
  border-radius: 0 2px 2px 0;
}
```

- [ ] **Step 2: 跑 typecheck + 起 dev 预览（仅 UI 验证）**

```bash
pnpm typecheck
```

预期：通过。token 变更不影响 TS 类型。**不**跑 lint（globals.css 不在 lint 范围）。

- [ ] **Step 3: Commit**

```bash
git add app/globals.css
git commit -m "chore(theme): replace oklch tokens with three light themes (blue/orange/green)"
```

---

## Task 3: 启用 next-themes + 删除 Google Fonts + lang=zh-CN

**Files:**
- Modify: `app/layout.tsx`
- Modify: `components/providers.tsx`

- [ ] **Step 1: 改 `app/layout.tsx`**

完全替换：

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prisim R2",
  description: "Cloudflare R2 存储桶管理控制台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

变化：删除 Google Fonts `@import url`（实际位置在 globals.css，已在 Task 2 删除）；`lang="en"` → `"zh-CN"`；metadata description 中文化。

- [ ] **Step 2: 读 `components/providers.tsx`**

```bash
cat components/providers.tsx
```

确认这个文件现状（应该是 TanStack Query Provider）。

- [ ] **Step 3: 改 `components/providers.tsx` 加入 ThemeProvider**

在现有 Providers 嵌套结构中加 `ThemeProvider`（最外层，因为它操作 `<html>` 属性）：

```tsx
"use client";

import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="blue"
      themes={["blue", "orange", "green"]}
      enableSystem={false}
      enableColorScheme={false}
      storageKey="prisim-r2-theme"
    >
      <QueryClientProvider client={client}>
        {children}
        <Toaster richColors closeButton position="bottom-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

**注意**：保留现有 Providers 中的其他 Provider 嵌套；上面是参考结构，实施时以现有文件为准，只追加 ThemeProvider 外层。

- [ ] **Step 4: 跑 typecheck**

```bash
pnpm typecheck
```

预期：通过。next-themes 已经在 package.json 里。

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx components/providers.tsx
git commit -m "feat(theme): enable next-themes with three-theme support"
```

---

## Task 4: lib/i18n/common.ts + error-messages.ts + 单测

**Files:**
- Create: `lib/i18n/common.ts`
- Create: `lib/i18n/error-messages.ts`
- Create: `tests/unit/i18n/error-messages.test.ts`

- [ ] **Step 1: 写 `lib/i18n/common.ts`**

```ts
// lib/i18n/common.ts
//
// 公共词字典 —— 在多个组件中重复出现的短文案集中在这里。
// 长文案、错误消息、占位符不放这里，由各组件文件顶部的 const T = {...} 块管。

export const COMMON = {
  cancel: "取消",
  confirm: "确认",
  save: "保存",
  delete: "删除",
  copy: "复制",
  copied: "已复制",
  retry: "重试",
  close: "关闭",
  create: "新建",
  refresh: "刷新",
  loading: "加载中…",
  edit: "编辑",
  rename: "重命名",
  preview: "预览",
  download: "下载",
  upload: "上传",
  back: "返回",
  next: "下一步",
  previous: "上一步",
} as const;
```

- [ ] **Step 2: 写 `lib/i18n/error-messages.ts`**

```ts
// lib/i18n/error-messages.ts
//
// API 错误码 → 用户可读的中文文案。Sub-spec 1 只覆盖 V1 现有的 code；
// 新加的 code 随实现随补。describeError 用兜底 "操作失败（<code>）"
// 防止漏映射导致界面显示空白。

export const ERROR_MESSAGES: Record<string, string> = {
  "auth.invalid_credentials": "邮箱或密码错误",
  "auth.upstream_error": "认证服务暂时不可用，请稍后再试",
  "csrf.invalid": "会话已过期，请刷新页面",
  "csrf.missing": "缺少安全令牌，请刷新页面",
  "confirmation.required": "请输入对应名称以确认",
  "rate_limit.exceeded": "操作过于频繁，请稍后再试",
  "validation.failed": "请求参数有误",
  "r2.credentials_invalid": "R2 凭据无效或已过期",
  "r2.upstream_error": "R2 暂时不可用，请稍后再试",
  "share.expired": "分享链接已过期",
  "share.not_found": "找不到对应的分享记录",
  "connection.not_found": "找不到对应的连接",
  "object.not_found": "找不到对应的对象",
};

export function describeError(code: string | undefined | null): string {
  if (!code) return "未知错误";
  return ERROR_MESSAGES[code] ?? `操作失败（${code}）`;
}
```

- [ ] **Step 3: 写测试 `tests/unit/i18n/error-messages.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import {
  describeError,
  ERROR_MESSAGES,
} from "@/lib/i18n/error-messages";

describe("describeError", () => {
  it("returns mapped Chinese text for known codes", () => {
    expect(describeError("auth.invalid_credentials")).toBe("邮箱或密码错误");
    expect(describeError("csrf.invalid")).toBe("会话已过期，请刷新页面");
  });

  it("falls back to '操作失败（<code>）' for unknown codes", () => {
    expect(describeError("totally.fake.code")).toBe("操作失败（totally.fake.code）");
  });

  it("returns '未知错误' for null/undefined/empty", () => {
    expect(describeError(null)).toBe("未知错误");
    expect(describeError(undefined)).toBe("未知错误");
    expect(describeError("")).toBe("未知错误");
  });

  it("covers the V1 error codes referenced in the spec", () => {
    const required = [
      "auth.invalid_credentials",
      "auth.upstream_error",
      "csrf.invalid",
      "confirmation.required",
      "rate_limit.exceeded",
    ];
    for (const code of required) {
      expect(ERROR_MESSAGES[code]).toBeDefined();
    }
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
pnpm test tests/unit/i18n/error-messages.test.ts
```

预期：4 个 test 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/i18n/ tests/unit/i18n/
git commit -m "feat(i18n): add common-word dictionary and error-code translator"
```

---

## Task 5: pick-home-route 改造（dashboard-first）+ home-redirector 改造

**Files:**
- Modify: `components/features/dashboard/pick-home-route.ts`
- Modify: `components/features/dashboard/home-redirector.tsx`
- Create: `tests/unit/dashboard/pick-home-route.test.ts`（若 `tests/unit/dashboard/` 不存在则一并创建）

- [ ] **Step 1: 写测试 `tests/unit/dashboard/pick-home-route.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { pickHomeRoute } from "@/components/features/dashboard/pick-home-route";

describe("pickHomeRoute", () => {
  it("returns /dashboard when no callbackUrl is supplied", () => {
    expect(pickHomeRoute({ activeConnectionId: null, activeBucket: null })).toBe(
      "/dashboard",
    );
    expect(
      pickHomeRoute({ activeConnectionId: "conn_01", activeBucket: null }),
    ).toBe("/dashboard");
    expect(
      pickHomeRoute({ activeConnectionId: "conn_01", activeBucket: "dev" }),
    ).toBe("/dashboard");
  });

  it("respects a callbackUrl when provided", () => {
    expect(
      pickHomeRoute(
        { activeConnectionId: "conn_01", activeBucket: "dev" },
        "/buckets/dev/sub",
      ),
    ).toBe("/buckets/dev/sub");
  });

  it("rejects external callbackUrls (open-redirect guard)", () => {
    expect(
      pickHomeRoute(
        { activeConnectionId: null, activeBucket: null },
        "https://evil.example/",
      ),
    ).toBe("/dashboard");
    expect(
      pickHomeRoute(
        { activeConnectionId: null, activeBucket: null },
        "//evil.example/x",
      ),
    ).toBe("/dashboard");
  });

  it("rejects callbackUrls that do not start with /", () => {
    expect(
      pickHomeRoute({ activeConnectionId: null, activeBucket: null }, "javascript:alert(1)"),
    ).toBe("/dashboard");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
pnpm test tests/unit/dashboard/pick-home-route.test.ts
```

预期：FAIL（旧实现走 `/settings/connections`，且不支持 callbackUrl 参数）。

- [ ] **Step 3: 改 `components/features/dashboard/pick-home-route.ts`**

完全替换：

```ts
// components/features/dashboard/pick-home-route.ts
//
// Pure routing decision for the home page bouncer.
//
// Sub-spec 1: dashboard-first. /dashboard is the safe landing page that
// every authenticated user can reach regardless of whether they have a
// connection or a bucket selected. Sub-spec 2 will replace the placeholder
// dashboard with the real overview.
//
// callbackUrl support: if a relative path is supplied (e.g. middleware
// redirected the user mid-navigation), honor it. Reject any URL that
// isn't a same-origin relative path to prevent open-redirect.

export function pickHomeRoute(
  state: {
    activeConnectionId: string | null;
    activeBucket: string | null;
  },
  callbackUrl?: string | null,
): string {
  if (callbackUrl && isSafeRelative(callbackUrl)) {
    return callbackUrl;
  }
  return "/dashboard";
}

function isSafeRelative(url: string): boolean {
  if (!url.startsWith("/")) return false;
  // 防 //evil/path 形式的协议相对 URL
  if (url.startsWith("//")) return false;
  return true;
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
pnpm test tests/unit/dashboard/pick-home-route.test.ts
```

预期：4 个 test 全部 PASS。

- [ ] **Step 5: 改 `components/features/dashboard/home-redirector.tsx`**

完全替换：

```tsx
"use client";

// components/features/dashboard/home-redirector.tsx
//
// Client-side bouncer rendered by app/page.tsx for authenticated users.
// Now goes to /dashboard unconditionally (except when middleware passed
// a callbackUrl mid-navigation, which the underlying pickHomeRoute honors).

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { pickHomeRoute } from "@/components/features/dashboard/pick-home-route";
import { useActiveConnectionStore } from "@/stores/active-connection";

export function HomeRedirector() {
  const router = useRouter();
  const search = useSearchParams();

  useEffect(() => {
    const callbackUrl = search.get("callbackUrl");
    router.replace(
      pickHomeRoute(useActiveConnectionStore.getState(), callbackUrl),
    );
  }, [router, search]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        正在跳转…
      </p>
    </div>
  );
}
```

- [ ] **Step 6: 检查 app/page.tsx 是否需要 Suspense 包裹**

```bash
cat app/page.tsx
```

`useSearchParams` 必须在 Suspense 内才能在 SSR 阶段不阻塞。若 `app/page.tsx` 没有 Suspense 包裹 `<HomeRedirector />`，添加：

```tsx
import { Suspense } from "react";
// ...
<Suspense fallback={<div />}>
  <HomeRedirector />
</Suspense>
```

具体修改方式见 app/page.tsx 现有结构。

- [ ] **Step 7: typecheck + 测试全跑**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add components/features/dashboard/pick-home-route.ts \
        components/features/dashboard/home-redirector.tsx \
        tests/unit/dashboard/ \
        app/page.tsx
git commit -m "feat(routes): home redirect goes to /dashboard unless callbackUrl set"
```

---

## Task 6: 路由占位页（4 个）+ /settings/connections redirect

**Files:**
- Create: `app/(dashboard)/dashboard/page.tsx`
- Create: `app/(dashboard)/buckets/page.tsx`
- Create: `app/(dashboard)/settings/page.tsx`
- Create: `app/(dashboard)/connections/page.tsx`
- Modify: `app/(dashboard)/settings/connections/page.tsx`

- [ ] **Step 1: 写 `app/(dashboard)/dashboard/page.tsx`**

```tsx
"use client";

import Link from "next/link";

const T = {
  title: "仪表盘",
  comingSoon: "仪表盘内容将在后续版本上线。",
  cta: "去存储桶",
} as const;

export default function DashboardPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.comingSoon}</p>
      <Link
        href="/buckets"
        className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        {T.cta}
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: 写 `app/(dashboard)/buckets/page.tsx`**

```tsx
"use client";

const T = {
  title: "存储桶",
  hint: "从顶栏切换 Bucket 或在左侧选择一个 Bucket 开始浏览。",
} as const;

export default function BucketsIndexPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {T.hint}
      </p>
    </div>
  );
}
```

- [ ] **Step 3: 写 `app/(dashboard)/settings/page.tsx`**

```tsx
"use client";

const T = {
  title: "设置",
  comingSoon: "更多设置项即将上线。连接管理已迁移到左侧「连接管理」入口。",
} as const;

export default function SettingsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {T.comingSoon}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: 读 `app/(dashboard)/settings/connections/page.tsx` 的内容**

```bash
cat 'app/(dashboard)/settings/connections/page.tsx'
```

把它的全部内容（导入 + 组件）记下来，准备搬到新位置。

- [ ] **Step 5: 写 `app/(dashboard)/connections/page.tsx`**

把 Step 4 读到的内容**整体复制**到这里。修改 import 路径如果是相对路径（应该是 `@/` 绝对路径，无需改动）。

- [ ] **Step 6: 替换 `app/(dashboard)/settings/connections/page.tsx` 为 redirect**

```tsx
import { redirect } from "next/navigation";

export default function LegacyConnectionsRedirect() {
  redirect("/connections");
}
```

注意：这是服务端 redirect（next/navigation 的 `redirect()` 仅在 RSC / 服务端组件中生效，永远是 308 永久重定向）。

- [ ] **Step 7: typecheck**

```bash
pnpm typecheck
```

预期：通过。

- [ ] **Step 8: Commit**

```bash
git add 'app/(dashboard)/dashboard/' \
        'app/(dashboard)/buckets/page.tsx' \
        'app/(dashboard)/settings/page.tsx' \
        'app/(dashboard)/connections/' \
        'app/(dashboard)/settings/connections/page.tsx'
git commit -m "feat(routes): add /dashboard /buckets /settings /connections; redirect /settings/connections"
```

---

## Task 7: 主题切换器组件 + 单测

**Files:**
- Create: `components/features/dashboard/theme-switcher.tsx`
- Create: `tests/unit/features/dashboard/theme-switcher.test.tsx`

- [ ] **Step 1: 写测试 `tests/unit/features/dashboard/theme-switcher.test.tsx`**

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// next-themes 的 useTheme hook 在测试环境下不能正常工作（没有 Provider），
// 在测试入口 mock 掉。
const setTheme = vi.fn();
let currentTheme = "blue";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: currentTheme, setTheme }),
}));

import { ThemeSwitcher } from "@/components/features/dashboard/theme-switcher";

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    setTheme.mockClear();
    currentTheme = "blue";
  });

  it("renders the trigger with the current theme label", () => {
    render(<ThemeSwitcher />);
    expect(screen.getByText("经典蓝")).toBeInTheDocument();
  });

  it("opens popover and lists all three themes when clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    expect(screen.getByText("经典蓝")).toBeInTheDocument();
    expect(screen.getByText("活力橙")).toBeInTheDocument();
    expect(screen.getByText("清新绿")).toBeInTheDocument();
  });

  it("calls setTheme('orange') when the orange row is clicked", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);
    await user.click(screen.getByRole("button", { name: /主题/ }));
    await user.click(screen.getByText("活力橙"));
    expect(setTheme).toHaveBeenCalledWith("orange");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
pnpm test tests/unit/features/dashboard/theme-switcher.test.tsx
```

预期：FAIL（组件不存在）。

- [ ] **Step 3: 写 `components/features/dashboard/theme-switcher.tsx`**

```tsx
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
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
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
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
pnpm test tests/unit/features/dashboard/theme-switcher.test.tsx
```

预期：3 个 test 全部 PASS。如果 `getByRole("button", { name: /主题/ })` 没匹配上，检查 aria-label `切换主题` 是否对 `/主题/` 正则匹配（应该会）。

- [ ] **Step 5: Commit**

```bash
git add components/features/dashboard/theme-switcher.tsx \
        tests/unit/features/dashboard/
git commit -m "feat(theme): add theme switcher pill in topbar"
```

---

## Task 8: 重写 bucket-switcher（顶栏版）+ 新增 user-menu

**Files:**
- Modify: `components/features/dashboard/bucket-switcher.tsx`
- Create: `components/features/dashboard/user-menu.tsx`

- [ ] **Step 1: 读现有 bucket-switcher.tsx**

```bash
cat 'components/features/dashboard/bucket-switcher.tsx'
```

记录现有职责（实际上是 connection switcher 的薄包装），准备整体替换。

- [ ] **Step 2: 重写 `components/features/dashboard/bucket-switcher.tsx`**

```tsx
"use client";

// components/features/dashboard/bucket-switcher.tsx
//
// 顶栏左侧的 Bucket 切换器。展示当前 connection 名（只读）+ 该连接下所有 bucket
// + "在 Cloudflare 控制台新建 Bucket" 外链。
//
// 切 connection 不在这里 —— 用户去左侧"连接管理"页切换。

import { useRouter } from "next/navigation";
import { Check, ChevronDown, Database, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnections } from "@/hooks/use-connections";
import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { cn } from "@/lib/utils";

const T = {
  ariaLabel: "切换存储桶",
  scopeLabel: "CONN",
  none: "未选择",
  connectionHead: (name: string, masked: string) => `连接：${name} · ${masked}`,
  bucketsHead: "存储桶",
  guideNoConn: "请先去「连接管理」添加连接",
  cloudflareNew: "在 Cloudflare 控制台新建 Bucket",
} as const;

export function BucketSwitcher() {
  const router = useRouter();
  const { activeConnectionId, activeBucket, setActiveBucket } =
    useActiveConnectionStore();
  const { data: connections } = useConnections();
  const { data: buckets } = useBuckets(activeConnectionId);

  const conn = connections?.find((c) => c.id === activeConnectionId) ?? null;
  const cloudflareUrl = conn
    ? `https://dash.cloudflare.com/?to=/:account/r2/overview`
    : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={T.ariaLabel}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm",
            "transition-colors hover:border-primary/40",
          )}
        >
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {T.scopeLabel}
          </span>
          <span className="h-3 w-px bg-border" aria-hidden />
          <span className="font-medium">{activeBucket ?? T.none}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {conn ? (
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {T.connectionHead(conn.name, conn.accountIdMasked ?? "—")}
          </DropdownMenuLabel>
        ) : (
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {T.guideNoConn}
          </DropdownMenuLabel>
        )}

        {conn ? (
          <>
            <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {T.bucketsHead}
            </DropdownMenuLabel>
            {(buckets ?? []).map((b) => {
              const active = b.name === activeBucket;
              return (
                <DropdownMenuItem
                  key={b.name}
                  onSelect={() => {
                    setActiveBucket(b.name);
                    router.push(`/buckets/${encodeURIComponent(b.name)}`);
                  }}
                  className="flex items-center gap-3 py-1.5"
                >
                  <Database
                    className="h-3.5 w-3.5 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                  <span className="flex-1 truncate font-medium">{b.name}</span>
                  {active ? (
                    <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
                  ) : (
                    <span className="w-3.5" aria-hidden />
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a
                href={cloudflareUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm"
              >
                <ExternalLink
                  className="h-3.5 w-3.5 text-muted-foreground"
                  strokeWidth={1.5}
                />
                {T.cloudflareNew}
              </a>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

**注意**：`useBuckets` 应返回形如 `{ name: string }[]`；如签名不同，调整对应字段访问。`Bucket` summary 类型在 `lib/api/types.ts`，确认后调整。

- [ ] **Step 3: 写 `components/features/dashboard/user-menu.tsx`**

```tsx
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
          <ChevronDown className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
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
```

- [ ] **Step 4: typecheck**

```bash
pnpm typecheck
```

修复任何 type 错误（比如 `useBuckets` 返回类型不符、`Connection` 字段名差异等）。

- [ ] **Step 5: Commit**

```bash
git add components/features/dashboard/bucket-switcher.tsx \
        components/features/dashboard/user-menu.tsx
git commit -m "feat(layout): rewrite bucket switcher for topbar; add user menu"
```

---

## Task 9: 重写 app-shell（顶栏 + 侧栏 + 6 项主导航 + bucket 二级）

**Files:**
- Modify: `components/layout/app-shell.tsx`
- Modify: `app/(dashboard)/layout.tsx`（如需要传 props 变化）

- [ ] **Step 1: 读 `app/(dashboard)/layout.tsx`**

```bash
cat 'app/(dashboard)/layout.tsx'
```

确认如何向 `<AppShell>` 注入 `user`、`connections`、`activeConnectionId` 等。

- [ ] **Step 2: 完全重写 `components/layout/app-shell.tsx`**

```tsx
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
      className="flex flex-col border-r border-border bg-sidebar-bg"
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
          // 特殊：当处于 /buckets/[bucket] 路径时高亮"存储桶"主项
          return (
            <div key={item.href}>
              <Link
                href={item.href}
                data-active={isActive}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                  isActive
                    ? "bg-primary-soft font-medium text-primary signal-bar"
                    : "text-fg-2 hover:bg-hover hover:text-foreground",
                )}
                style={
                  isActive
                    ? { color: "var(--primary)", background: "var(--primary-soft)" }
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
                            ? "bg-primary-soft font-medium text-primary"
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
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                activeConn.status === "ok" && "bg-success",
                activeConn.status === "warn" && "bg-warning",
                activeConn.status === "error" && "bg-destructive",
              )}
              aria-hidden
            />
            <span className="truncate text-xs font-medium">{activeConn.name}</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">未选择连接</p>
        )}
      </div>
    </aside>
  );
}
```

**注意事项**：
- 字段名 `accountIdMasked`、`status` 应与 `lib/api/types.ts` 的 `ConnectionSummary` 对齐
- `useBuckets(id)` 返回类型确认（看 `hooks/use-buckets.ts`）
- 若 `useConnections` 或 `useBuckets` 返回 `data` 为 `ConnectionSummary[] | undefined`，要求按现有 hook 签名调整

- [ ] **Step 3: 改 `app/(dashboard)/layout.tsx`**

读现有内容，调整传给 `<AppShell>` 的 props（去掉旧的 `activeNav`、`onNavigate` 等回调，因为新版用 `usePathname` 自动判定活跃；同时不再接受 `connections`、`activeConnectionId` 等 prop —— 它们由组件内部通过 hook 自动读取）。新签名：

```tsx
<AppShell user={{ email: session.user.email }}>
  {children}
</AppShell>
```

- [ ] **Step 4: typecheck**

```bash
pnpm typecheck
```

修复所有 type 错误（特别注意 `useBuckets` 签名与 `Bucket` 类型的字段名）。

- [ ] **Step 5: 手动验证**

```bash
pnpm preview
```

打开 http://localhost:8788：登录 → 应看到新顶栏（Bucket switcher + 主题 + 用户）+ 新侧栏（6 项 + bucket 二级常驻展开）。三主题切换工作。

- [ ] **Step 6: Commit**

```bash
git add components/layout/app-shell.tsx 'app/(dashboard)/layout.tsx'
git commit -m "refactor(layout): rebuild app shell with bucket switcher and 6-item sidebar"
```

---

## Task 10: 中文化登录页

**Files:**
- Modify: `app/(auth)/login/page.tsx`

- [ ] **Step 1: 改 `app/(auth)/login/page.tsx`**

文件已存在 ~256 行。**只改文案 + 替换 `setError` 的写法走 `describeError`，不改业务流程**。

具体改动（用 Edit 工具按下列对照表逐个替换）：

| old | new |
|---|---|
| `R2 · edge console` | `R2 · 边缘控制台` |
| `v1.0 · build local` | `v1.0 · 本地构建` |
| `Email` (Field label) | `邮箱` |
| `Password` (Field label) | `密码` |
| `placeholder="me@example.com"` | `placeholder="请输入邮箱"` |
| `placeholder="••••••••••••"` | 不变（视觉占位符） |
| `"Authenticating…"` | `"正在认证…"` |
| `"Sign in"` | `"登录"` |
| `Single-user instance. Add accounts via` | `单用户实例。可通过` |
| `.\n` 后面那句 | `添加账号。` |
| `AES-GCM at rest · presigned direct I/O` | `凭据 AES-GCM 加密 · 对象直传 R2` |
| `cloudflare pages` | 不变（部署平台名） |
| `Sign-in failed` | `登录失败` |
| `encrypted` (Letterhead) | `加密` |

错误显示走 `describeError`：

```tsx
import { describeError } from "@/lib/i18n/error-messages";
// ...
{error ? (
  <ErrorBanner code={error} message={describeError(error)} />
) : null}
```

并改 `ErrorBanner` 签名让它显示 `message` + 折叠 `code` 到次行小字。

注意：`setError("auth.invalid_credentials")` 与 `setError("auth.upstream_error")` 这两个调用保持原样（它们写的是 code）。

- [ ] **Step 2: typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add 'app/(auth)/login/page.tsx'
git commit -m "i18n(auth): localize login page to simplified chinese"
```

---

## Task 11: 中文化 audit 页 + shares 页

**Files:**
- Modify: `app/(dashboard)/audit/page.tsx`
- Modify: `app/(dashboard)/shares/page.tsx`

- [ ] **Step 1: 改 `app/(dashboard)/audit/page.tsx`**

在文件顶部 import 后添加：

```tsx
const T = {
  pageTitle: "审计日志",
  pageDesc: "账户内的状态变更操作记录。只读。",
  thTime: "时间",
  thOp: "操作",
  thBucket: "Bucket",
  thKey: "Key",
  thStatus: "状态",
  thIp: "IP",
  opLabel: "操作类型",
  bucketLabel: "存储桶",
  opAll: "全部",
  bucketPlaceholder: "精确 bucket 名…",
  loadMore: "加载更多",
  loading: "加载中…",
  loadError: "无法加载审计日志",
  retry: "重试",
  emptyTitle: "暂无审计记录",
  emptyHint: "随着你使用本应用，操作会被记录在这里。试试移除筛选条件。",
  arOpAria: "按操作类型筛选",
  arBucketAria: "按 bucket 名筛选",
} as const;
```

并在组件内逐个替换英文为对应 `T.xxx`：
- `<h1>Audit log</h1>` → `<h1>{T.pageTitle}</h1>`
- `State-changing operations recorded against your account. Read-only.` → `{T.pageDesc}`
- `<Th>Time</Th>` → `<Th>{T.thTime}</Th>` 等
- `<option value="">All</option>` → `<option value="">{T.opAll}</option>`
- `placeholder="exact bucket name…"` → `placeholder={T.bucketPlaceholder}`
- `aria-label="Filter by operation"` → `aria-label={T.arOpAria}`
- `aria-label="Filter by bucket name"` → `aria-label={T.arBucketAria}`
- 三个 `Loading…` → `{T.loading}`
- `Load more` → `{T.loadMore}`
- `Couldn't load audit log.` → `{T.loadError}`
- `Retry` → `{T.retry}`
- `No audit entries.` → `{T.emptyTitle}`
- `Operations are recorded as you use the app. Try removing filters.` → `{T.emptyHint}`

- [ ] **Step 2: 读 `app/(dashboard)/shares/page.tsx` + 改文案**

```bash
cat 'app/(dashboard)/shares/page.tsx'
```

按同样模式：顶部加 `const T = {...}`，逐个替换英文。文案对照（按设计稿与 V1 功能）：

```tsx
const T = {
  pageTitle: "分享链接",
  pageDesc: "通过 presigned URL 共享对象。链接到期后自动失效。",
  thObject: "对象",
  thBucket: "Bucket",
  thCreated: "创建时间",
  thExpires: "剩余有效期",
  thActions: "操作",
  warning: "删除分享记录不会让 URL 立即失效。URL 会在 TTL 到期后自然失效。",
  noShares: "暂无分享链接",
  showLink: "查看链接",
  revoke: "删除记录",
  refresh: "刷新",
  copyLink: "复制链接",
  expired: "已过期",
  expireIn: (s: string) => `剩余 ${s}`,
} as const;
```

按实际页面结构替换。

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add 'app/(dashboard)/audit/page.tsx' 'app/(dashboard)/shares/page.tsx'
git commit -m "i18n(audit,shares): localize page strings to simplified chinese"
```

---

## Task 12: 中文化 connections 全部组件（5 个）

**Files:**
- Modify: `components/features/connections/connections-table.tsx`
- Modify: `components/features/connections/add-connection-dialog.tsx`
- Modify: `components/features/connections/connection-switcher.tsx`
- Modify: `components/features/connections/delete-connection-dialog.tsx`
- Modify: `components/features/connections/rename-connection-dialog.tsx`

- [ ] **Step 1: 改 `connections-table.tsx`**

加 `const T`：

```tsx
const T = {
  thName: "名称",
  thAccountId: "Account ID",
  thAccessKey: "Access Key",
  thLastUsed: "最近使用",
  thActions: "操作",
  refresh: "刷新",
  add: "新建连接",
  empty: "暂无连接",
  emptyHint: "点击右上「新建连接」添加第一个 R2 连接。",
  rename: "重命名",
  delete: "删除",
  copyKeyId: "复制 Key ID",
  testConnection: "测试连接",
  testing: "测试中…",
  status: { ok: "正常", warn: "未使用", error: "异常" },
} as const;
```

替换组件内对应英文。

- [ ] **Step 2: 改 `add-connection-dialog.tsx`**

```tsx
const T = {
  title: "新建连接",
  desc: "添加一个 Cloudflare R2 账号到本系统。Secret 提交后即 AES-GCM 加密，不再明文显示。",
  nameLabel: "名称",
  namePlaceholder: "给这个连接起个名字",
  accountIdLabel: "Account ID",
  accountIdPlaceholder: "从 Cloudflare URL 复制 32 位 hex",
  accessKeyIdLabel: "Access Key ID",
  accessKeyIdPlaceholder: "Cloudflare → R2 → 管理 API 令牌",
  secretLabel: "Secret Access Key",
  secretPlaceholder: "加密保存，提交后不再可见",
  submit: "添加",
  submitting: "正在添加…",
} as const;
```

替换所有英文 label / placeholder / 标题 / 描述。

- [ ] **Step 3: 改 `connection-switcher.tsx`**

注意：此组件在新版顶栏中**不再被 AppShell 使用**（被 `bucket-switcher.tsx` 替代）。但 `app/(dashboard)/connections/page.tsx` 内还在用它作为页面内的连接选择控件。所以仍需中文化：

```tsx
const T = {
  title: "选择连接",
  manage: "管理连接",
  add: "新建连接",
  // 复用 add-connection-dialog 的字段标签
  nameLabel: "名称",
  namePlaceholder: "给这个连接起个名字",
  accountIdLabel: "Account ID",
  accountIdPlaceholder: "8b21a3f4c705e6d09b8214f6c7a9b3d2",
  accessKeyIdLabel: "Access Key ID",
  accessKeyIdPlaceholder: "AKIA…",
  secretLabel: "Secret",
  secretPlaceholder: "••••••••••••••••••••••••••••••••",
  cancel: "取消",
  submit: "添加",
} as const;
```

- [ ] **Step 4: 改 `delete-connection-dialog.tsx`**

```tsx
const T = {
  title: "删除连接",
  desc: (name: string) => `永久删除连接「${name}」。该操作不可撤销。`,
  warn: "现有分享 URL 不会被立即撤销，将持续到 TTL 自然到期。",
  typeToConfirm: (name: string) => `输入「${name}」以确认`,
  cancel: "取消",
  delete: "删除连接",
  deleting: "正在删除…",
} as const;
```

- [ ] **Step 5: 改 `rename-connection-dialog.tsx`**

```tsx
const T = {
  title: "重命名连接",
  desc: "仅修改显示名，不会重新校验凭据。",
  nameLabel: "名称",
  cancel: "取消",
  save: "保存",
  saving: "正在保存…",
} as const;
```

- [ ] **Step 6: typecheck + 跑测试**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add components/features/connections/
git commit -m "i18n(connections): localize all connection dialogs and table"
```

---

## Task 13: 中文化 buckets/[bucket] + files 组件 + share-dialog + upload 组件

**Files:**
- Modify: `app/(dashboard)/buckets/[bucket]/[[...prefix]]/page.tsx`
- Modify: `components/features/files/breadcrumb.tsx`
- Modify: `components/features/files/delete-dialog.tsx`
- Modify: `components/features/files/object-table.tsx`
- Modify: `components/features/files/preview-dialog.tsx`
- Modify: `components/features/share/share-dialog.tsx`
- Modify: `components/features/upload/dropzone.tsx`
- Modify: `components/features/upload/upload-drawer.tsx`
- Modify: `components/features/upload/upload-drawer-container.tsx`
- Modify: `components/features/upload/upload-queue-provider.tsx`

- [ ] **Step 1: 改 `buckets/[bucket]/[[...prefix]]/page.tsx`**

顶部加 `const T`：

```tsx
const T = {
  loadError: "无法加载对象列表",
  retry: "重试",
  empty: "此前缀下没有对象",
  emptyHint: "上传文件或切换前缀。",
  loading: "加载中…",
  loadMore: "加载更多",
} as const;
```

替换组件内对应英文。

- [ ] **Step 2: 改 `components/features/files/breadcrumb.tsx`**

```tsx
const T = {
  root: "根目录",
} as const;
```

替换英文 "Root" 等。

- [ ] **Step 3: 改 `components/features/files/object-table.tsx`**

```tsx
const T = {
  thName: "名称",
  thSize: "大小",
  thModified: "修改时间",
  thType: "类型",
  thActions: "操作",
  preview: "预览",
  download: "下载",
  share: "分享",
  delete: "删除",
  copyKey: "复制 Key",
  selectedN: (n: number) => `已选 ${n} 项`,
  bulkDelete: "批量删除",
  bulkClear: "清除选择",
  emptyTitle: "空文件夹",
  emptyHint: "拖入文件开始上传，或在地址栏切换前缀。",
} as const;
```

替换。

- [ ] **Step 4: 改 `components/features/files/delete-dialog.tsx`**

```tsx
const T = {
  title: "删除对象",
  descSingle: (key: string) => `永久删除「${key}」。该操作不可撤销。`,
  descMany: (n: number) => `永久删除选中的 ${n} 个对象。该操作不可撤销。`,
  typeToConfirm: (bucket: string) => `输入「${bucket}」以确认`,
  cancel: "取消",
  delete: "删除",
  deleting: "正在删除…",
} as const;
```

替换。

- [ ] **Step 5: 改 `components/features/files/preview-dialog.tsx`**

```tsx
const T = {
  loading: "正在加载预览…",
  loadFailed: "预览失败",
  unsupported: "不支持的文件类型",
  unsupportedHint: "请下载后用本地应用打开。",
  closeShortcut: "Esc 关闭",
  download: "下载原文件",
  copyKey: "复制 Key",
} as const;
```

替换。

- [ ] **Step 6: 改 `components/features/share/share-dialog.tsx`**

```tsx
const T = {
  shareTitle: "分享对象",
  shareDesc: "创建一个有时限的 presigned URL。链接任何人都能访问，到期自动失效。",
  ttlLabel: "有效期",
  ttl1h: "1 小时",
  ttl1d: "1 天",
  ttl7d: "7 天",
  cancel: "取消",
  create: "创建分享",
  creating: "正在创建…",
  readyTitle: "分享链接已生成",
  readyDesc: "复制下面的 URL。该链接只展示这一次，关闭对话框后不可再次查看。",
  copyUrl: "复制链接",
  copied: "已复制",
  close: "关闭",
} as const;
```

替换。

- [ ] **Step 7: 改 `components/features/upload/dropzone.tsx`**

```tsx
const T = {
  hint: "拖拽文件到此处上传",
  hintSub: "或点击选择",
  dropping: "释放鼠标开始上传",
} as const;
```

- [ ] **Step 8: 改 `components/features/upload/upload-drawer.tsx` + container.tsx**

```tsx
const T = {
  title: "上传队列",
  empty: "队列为空",
  retry: "重试",
  cancel: "取消",
  clear: "清空",
  done: "完成",
  failed: "失败",
  uploading: "上传中…",
  paused: "已暂停",
  pending: "等待中",
  fileN: (n: number) => `${n} 个文件`,
} as const;
```

替换两个文件中的英文。

- [ ] **Step 9: 改 `components/features/upload/upload-queue-provider.tsx`**

文案极少（通常都是状态文字），按实际内容替换。

- [ ] **Step 10: typecheck + test**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 11: Commit**

```bash
git add 'app/(dashboard)/buckets/' \
        components/features/files/ \
        components/features/share/ \
        components/features/upload/
git commit -m "i18n(files,share,upload): localize bucket browser, preview, share, upload"
```

---

## Task 14: 中文化剩余（dashboard 组件 + ui/dialog 默认值 + utils）

**Files:**
- Modify: `components/features/dashboard/sign-out-button.tsx`
- Modify: `components/features/dashboard/logo.tsx`
- Verify: `components/ui/dialog.tsx`

- [ ] **Step 1: 改 `sign-out-button.tsx`**

读现状 → 替换英文 "Sign out" 等为 "退出登录"。

- [ ] **Step 2: 改 `logo.tsx`**

读现状 → 若有英文 tagline 替换；保持 `Prisim R2` 品牌名不变。

- [ ] **Step 3: 检查 `components/ui/dialog.tsx` 的 `Close` 兜底**

```bash
grep -n "Close" components/ui/dialog.tsx
```

按 spec §3.5 规定**不**直接改 ui/。改为在外部用法中显式传 `<DialogClose>关闭</DialogClose>` 即可（绝大多数对话框已经有自己的关闭按钮，shadcn 默认 "Close" 只在没传时生效）。验证：grep 应用层是否有未传文案的 `<DialogClose>`：

```bash
grep -rn "<DialogClose" app/ components/features/
```

若有，给它们补中文文案。

- [ ] **Step 4: 中文化 `lib/utils.ts` 的 `formatRelative()` 等工具**

```bash
grep -n "second\|minute\|hour\|day\|ago\|just now" lib/utils.ts
```

若 `formatRelative` 返回英文（如 `"5 min ago"`），改为中文（"5 分钟前"）。完整字典：

```ts
// "刚刚" | "<n> 秒前" | "<n> 分钟前" | "<n> 小时前" | "昨天" | "<n> 天前" | "<date>"
```

替换的同时确认现有调用方都按字符串使用（无 RegExp 截断）。

- [ ] **Step 5: typecheck + test**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add components/features/dashboard/ lib/utils.ts
git commit -m "i18n(misc): localize sign-out, logo, relative time formatter"
```

---

## Task 15: 最终验收

**Files:** N/A（只跑验证）

- [ ] **Step 1: 跑完整质量套件**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

预期：三个都全绿。

- [ ] **Step 2: 起 Cloudflare 预览**

```bash
pnpm preview
```

打开 http://localhost:8788 走完手动验收清单（spec §7.2）：

- [ ] 登录页全中文（含占位符 `请输入邮箱`、`请输入密码`）
- [ ] 登录后默认落地 `/dashboard`
- [ ] 顶栏左侧 `[CONN | <bucket> ▾]`
- [ ] 顶栏右侧主题切换 pill + 用户菜单（含邮箱、popover 内"退出登录"）
- [ ] 切主题：经典蓝 → 活力橙 → 清新绿；F5 刷新主题保持
- [ ] shadcn 按钮 / 表格 / 输入框 / 弹窗边框 / 焦点环全部跟随主题
- [ ] 侧栏 6 项中文，"存储桶"下 bucket 二级列表常驻展开
- [ ] 点 `/connections` 看到连接管理；访问 `/settings/connections` 自动跳到 `/connections`
- [ ] `/settings` 看占位页
- [ ] DevTools Network 无 fonts.googleapis 请求

- [ ] **Step 3: grep 英文残留**

```bash
grep -rEn 'placeholder=".*[A-Za-z]' app/ components/features/ | grep -v "^.*placeholder=\"\"" | grep -v "placeholder=\"[0-9]"
```

预期：无输出（或仅 ASCII URL/hex 示例如 `8b21a3...`）。

```bash
grep -rEn '>\s*[A-Z][a-zA-Z ]+\s*<' app/ components/features/
```

预期：输出极少且都是合理的（如品牌名 `Prisim`、保留的 mono 标签 `CONN`、`MIME` 等）。

- [ ] **Step 4: 用 taskmaster 记录决策**

按 CLAUDE.md §workflow rules 第 2 条，把本 Sub-spec 1 的关键决策（next-themes 选型、用户菜单偏离设计稿、路由结构调整）写进 taskmaster 对应 subtask 的 `update_subtask`。如果 taskmaster 没有对应 subtask，跳过此步。

- [ ] **Step 5: 总览 commit 历史**

```bash
git log --oneline main..HEAD
```

预期：~14 个 commit（每个 task 一个），全部 Conventional Commits 格式。

- [ ] **Step 6: 准备 PR（不自动 push）**

```bash
git status
git log --oneline -20
```

向用户确认验收清单全部打勾、本地预览看过，再让用户决定 `pnpm deploy` / `git push` / 开 PR。

---

## Self-Review Notes

### Spec 覆盖检查
- ✅ §1.1 在范围内 8 条全部对应到 Task（i18n→T10-14, 三主题→T2-T3, 字体→T2, 删 dark→T2, 顶栏 Bucket switcher→T8, 顶栏主题+用户→T7-T8, 侧栏 6 项→T9, Logo→T9, 路由调整→T5-T6）
- ✅ §6.1 新建文件 11 个全部对应到 Task
- ✅ §6.2 重写文件 4 个全部对应到 Task
- ✅ §6.3 改文案文件全部对应到 T10-T14
- ✅ §7.1 三个单测对应到 T4 / T5 / T7
- ✅ §7.2 手动验收清单全部对应到 T15

### Placeholder 扫描
- 无 "TBD" / "TODO" / "implement later"
- 每个代码 step 都包含完整代码
- 命令都是可执行的

### 类型一致性
- `pickHomeRoute` 第二参数 `callbackUrl?: string | null` —— T5 测试与实现一致
- `ThemeName = 'blue' | 'orange' | 'green'` —— T7 测试 mock 与实现一致
- `BucketSwitcher` 使用 `useActiveConnectionStore` 的 `setActiveBucket` —— 该 method 在现有 store 已定义（已验证）
- `UserMenu` props `email: string` —— T8 实现与 T9 调用一致
- `AppShell` props `user: { email: string }` —— T9 实现与 T9 layout 调用一致
