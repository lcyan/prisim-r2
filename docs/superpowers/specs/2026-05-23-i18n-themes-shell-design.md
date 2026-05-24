# Sub-spec 1：i18n + 三主题 + 顶/侧栏对齐

**日期**：2026-05-23
**作者**：Claude（与 lcyan 协作 brainstorm）
**状态**：草案 · 待用户审阅
**前置背景**：用户在 `doc/prisim-r2-design.zip` 中提供 OpenDesign 设计稿。原始要求："所有界面文字必须简体中文，占位符也用中文，3 套配色"。整体改造范围是按设计稿 1:1 全面重写，已拆分为 6 个 sub-spec。本文档是 **Sub-spec 1（地基）**，后续仍有 5 个 sub-spec 待规划。

## 1. 范围与原则

### 1.1 在范围内

- 全部现有 UI 文案改简体中文（含占位符、按钮、表头、错误、空状态、aria-label）
- 三套亮色主题（经典蓝 / 活力橙 / 清新绿）token + `[data-theme]` 切换 + localStorage 持久化
- 字体栈：删除外加载 Fraunces/Geist/JetBrains Mono，改系统中文字体栈
- 删除 `.dark` 主题及其 oklch token
- 顶栏左侧改为 **Bucket 切换器**（dropdown：当前 connection 名为只读标签 + 该连接下所有 bucket + "在 Cloudflare 控制台新建 Bucket" 外链）
- 顶栏右侧 **主题切换器 pill**（独立 popover，含三主题行）
- 顶栏右侧 **用户 pill**（点击展开小菜单含邮箱 + 退出登录）—— 偏离设计稿"点击即退出"一处，理由：避免误点
- 侧栏 6 项顶级：仪表盘 / 存储桶（含 bucket 二级常驻展开）/ 分享链接 / 审计日志 / 连接管理 / 设置
- Logo 在侧栏顶部（设计稿原版）
- 路由调整：新增 `/dashboard`、`/buckets`（父）、`/settings`、`/connections` 占位/迁移；`/settings/connections` 永久重定向到 `/connections`

### 1.2 不在范围（移交后续 sub-spec）

| 内容 | 移交 |
|---|---|
| 仪表盘真实内容、Bucket 概览页（hero/metric/sparkline/用量条） | Sub-spec 2 |
| 文件浏览强化（56px 拖拽栏 / 视图切换 / 表头排序 / 批量条）+ 三栏 lightbox 预览 | Sub-spec 3 |
| 分享强化（TTL 时长卡 / show-link / 过期过滤）+ 审计强化（OP/Bucket/日期范围过滤 + 详情抽屉 + CSV/JSON 导出 + Pill 颜色语义） | Sub-spec 4 |
| Bucket 子页：CORS / 自定义域名 / Lifecycle | Sub-spec 5 |
| 空状态插画、键盘快捷键面板、响应式断点（移动抽屉化）、主题切换动画、全局搜索 `⌘K`、通知中心、文档帮助按钮 | Sub-spec 6 |

### 1.3 原则

- **不动业务逻辑**：所有 API、auth、R2、加密保持原样，只改 UI 文案、token、布局。
- **i18n 用硬编码中文**（用户已选）：但加一层约束——每个 page/组件文件顶部声明 `const T = { … } as const` 中文文案块，组件内只引用 `T.xxx` 不写裸字符串。便于后续接 i18n 库时低成本迁移。

## 2. 主题系统

### 2.1 token 分层

**通用 token（所有主题共享，单声明在 `:root`）**

```css
--fg: #1F2329; --fg-2: #4E5969; --muted: #86909C; --muted-2: #C9CDD4;
--border: #E5E6EB; --border-strong: #D1D5DB;
--surface: #FFFFFF; --sidebar-bg: #FFFFFF;
--success: #00B42A; --success-soft: #E8FFEA;
--warning: #FF7D00; --warning-soft: #FFF7E8;
--danger:  #F53F3F; --danger-soft:  #FFECE8;
--primary-fg: #FFFFFF;
--radius-sm: 4px; --radius: 6px; --radius-lg: 10px; --radius-xl: 14px;
--shadow-sm: 0 1px 2px rgba(15,23,42,.04);
--shadow-md: 0 4px 14px rgba(15,23,42,.08);
--shadow-lg: 0 24px 60px rgba(15,23,42,.18);

--font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
--font-mono: "SF Mono", "JetBrains Mono", Monaco, Menlo, Consolas, "Source Han Mono", monospace;
```

**主题专属 token（按 `[data-theme]` 切换）**

| token | Blue | Orange | Green |
|---|---|---|---|
| `--primary` | `#1677FF` | `#FF6A00` | `#00B96B` |
| `--primary-hover` | `#4391FF` | `#FF8A33` | `#2FCD8A` |
| `--primary-active` | `#0E5FD8` | `#DB5A00` | `#009957` |
| `--primary-soft` | `#F0F5FF` | `#FFF7ED` | `#ECFDF5` |
| `--primary-soft-strong` | `#E6EFFF` | `#FFEAD1` | `#D2F7E5` |
| `--content-bg` | `#F5F7FA` | `#FFFBF5` | `#F6FEFA` |
| `--row-hover` | `#F7F9FC` | `#FFF7ED` | `#ECFDF5` |
| `--hover` | `rgba(22,119,255,.06)` | `rgba(255,106,0,.06)` | `rgba(0,185,107,.06)` |
| `--info` | `#1677FF` | `#FF6A00` | `#00B96B` |
| `--info-soft` | `#F0F5FF` | `#FFF7ED` | `#ECFDF5` |

### 2.2 shadcn ↔ 设计稿 token 桥接

shadcn 组件硬依赖 `--background` / `--foreground` / `--primary` / `--ring` 等命名。在 `app/globals.css` 用 Tailwind v4 的 `@theme inline` 桥接：

```css
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
```

这样所有 shadcn 组件切主题自动跟随，无需修改组件代码。

### 2.3 主题状态与持久化

**采用 next-themes**（项目已装 `next-themes@0.4.6`，未启用）。该库专为多主题设计，自带 FOUC 防护、SSR 兼容、`<html data-theme>` 同步、localStorage 持久化。无需自己实现 Zustand store 与 FOUC script。

配置：

```tsx
// app/layout.tsx
import { ThemeProvider } from 'next-themes';

<ThemeProvider
  attribute="data-theme"
  defaultTheme="blue"
  themes={['blue', 'orange', 'green']}
  enableSystem={false}
  storageKey="prisim-r2-theme"
>
  {children}
</ThemeProvider>
```

使用：

```tsx
// 任意客户端组件
import { useTheme } from 'next-themes';
const { theme, setTheme } = useTheme();
setTheme('orange');
```

next-themes 自动注入 inline script 在 `<head>` 顶部读 localStorage 并设置 `<html data-theme="…">`，杜绝 FOUC。

### 2.4 主题切换器组件

文件：`components/features/dashboard/theme-switcher.tsx`

- 顶栏右侧独立 pill：`[●swatch 经典蓝 ▾]` —— swatch 12×12 圆当前主题 `--primary` 实色
- 点击展开 popover：
  - 标题 `亮色主题`
  - 三行 row，每行：3 色块 mini-preview（primary + soft + bg）+ 主题名（加粗）+ hex metadata（小字）+ 选中态勾选
  - 三主题元数据：
    - 经典蓝 · `#1677FF · #F0F5FF`
    - 活力橙 · `#FF6A00 · #FFF7ED`
    - 清新绿 · `#00B96B · #ECFDF5`
- **不**实现设计稿底部"三主题对比 / 切换演示 / 色板汇总 / 导航图"四个外链（dev-only 链接，生产不需要）

## 3. i18n 文案规范

### 3.1 文案组织

- 每个 page/组件文件顶部声明 `const T = { … } as const` 中文文案块。
- 命名按语义平铺：`T.signIn` / `T.signingIn` / `T.invalidCredentials` / `T.emailPlaceholder`。**不**嵌套对象。
- 公共词（"取消" / "确认" / "保存" / "删除" / "复制" / "重试" / "关闭" / "新建" / "刷新"）抽到 `lib/i18n/common.ts`。

### 3.2 占位符规范

| 字段 | 占位符 |
|---|---|
| 邮箱输入 | `请输入邮箱` |
| 密码输入 | `请输入密码` |
| 连接名称 | `给这个连接起个名字` |
| Account ID | `从 Cloudflare URL 复制 32 位 hex` |
| Access Key ID | `Cloudflare → R2 → 管理 API 令牌` |
| Secret Access Key | `加密保存，提交后不再可见` |
| 审计 bucket 过滤 | `精确 bucket 名…` |
| typed confirmation | `输入 <name> 以确认删除` |

密码框的视觉占位符 `••••••••••••` 不变（非文字）。

### 3.3 错误消息

集中映射 `lib/i18n/error-messages.ts`：

```ts
export const ERROR_MESSAGES: Record<string, string> = {
  'auth.invalid_credentials': '邮箱或密码错误',
  'auth.upstream_error': '认证服务暂时不可用，请稍后再试',
  'csrf.invalid': '会话已过期，请刷新页面',
  'confirmation.required': '请输入对应名称以确认',
  'rate_limit.exceeded': '操作过于频繁，请稍后再试',
  // 实施时随用随加；不预先穷举
};
export function describeError(code: string): string {
  return ERROR_MESSAGES[code] ?? `操作失败（${code}）`;
}
```

`describeError(code)` 用于客户端 ErrorBanner / toast；技术 code 折叠到次行小字便于排查。

### 3.4 文案来源

1. **首选**：设计稿 `index.html` 同位置中文（事实标准）
2. **回填**：设计稿没覆盖的从 `CLAUDE-CODE-PROMPT.md` 与原型截图反推

### 3.5 影响范围

- 32 处 `placeholder=` / `aria-label=` 改为中文
- 现有英文按钮/标签估算 ~80-100 处
- `components/ui/dialog.tsx` 有英文兜底 `Close`，**不**手改 ui/，而是在外部 Dialog 包裹时显式传 `<DialogClose>关闭</DialogClose>`

## 4. 顶栏 + 侧栏布局

### 4.1 网格

```
sidebar(232) | topbar(56)
sidebar(232) | main(flex-1)
```

CSS：`grid-template: "sidebar topbar" 56px "sidebar main" 1fr / 232px 1fr;`

Logo 在**侧栏顶部**（设计稿原版），不在顶栏。顶栏左侧只有 Bucket 切换器。

### 4.2 顶栏

**左侧 · Bucket 切换器**（`components/features/dashboard/bucket-switcher.tsx`）

- 触发按钮：`[CONN | <bucket> ▾]`
- popover：
  - 第 1 行小标题：`连接：<connectionName> · <accountIdMasked>`（只读，灰色）
  - 第 2 行小标题：`存储桶`
  - bucket 列表：每行 `<name>` + `CREATED <date>` metadata + 右侧选中勾选
  - 底部分隔线 + 外链 `在 Cloudflare 控制台新建 Bucket`（新窗口，无 connection 时禁用）
- 数据：`useBuckets()` hook（已存在）
- 无 connection 时按钮显示 `[CONN | 未选择 ▾]`，popover 引导 `请先去 [连接管理] 添加连接`
- 切 bucket：调用 `useActiveConnection.setActiveBucket(name)`（store 已存在 `stores/active-connection.ts`，无需新增）+ `router.push('/buckets/' + name)`

**右侧 · 主题切换 pill**：见 §2.4

**右侧 · 用户 pill**（`components/features/dashboard/user-menu.tsx`）

- 触发：`[avatar 邮箱 ▾]`
- popover：
  - 邮箱（只读，灰色小字）
  - 分隔线
  - 一行 `退出登录`（左侧 LogOut 图标）
- 偏离设计稿原版"点击立即退出"，理由：误点风险。

### 4.3 侧栏

文件：`components/layout/app-shell.tsx` 内的 `Sidebar`，重写为：

- **顶部 brand 区**：logo `Prisim R2` + 小字 `CLOUDFLARE BUCKET MANAGER`
- **主导航 6 项**（皆 `<Link>`，活跃态左侧 2px primary 色 indicator）：

  | 顺序 | 标签 | 路径 | 图标 |
  |---|---|---|---|
  | 1 | 仪表盘 | `/dashboard` | `LayoutDashboard` |
  | 2 | 存储桶 | `/buckets` | `Database` |
  | 2.x | `<bucket name>` | `/buckets/<name>` | bullet 圆点（无图标） |
  | 3 | 分享链接 | `/shares` | `Link2` |
  | 4 | 审计日志 | `/audit` | `FileClock` |
  | 5 | 连接管理 | `/connections` | `Plug` |
  | 6 | 设置 | `/settings` | `Settings` |

- **bucket 二级常驻展开**：紧贴"存储桶"项下方，缩进 24px。`useBuckets()` 数据；无 connection 或无 bucket 时整段不渲染。
- **底部活动连接卡**：保留 status dot + connection 名（不再有退出按钮，因为已移到顶栏 user pill）

## 5. 路由调整

| 路径 | 实施动作 |
|---|---|
| `/` | 改 `HomeRedirector` 逻辑：默认去 `/dashboard`；有 `callbackUrl` 时尊重 callbackUrl |
| `/dashboard` | **新增** `app/(dashboard)/dashboard/page.tsx`：标题 `仪表盘` + 空状态文案 `仪表盘内容将在后续版本上线` + CTA 按钮 `去存储桶` |
| `/buckets` | **新增** `app/(dashboard)/buckets/page.tsx`：标题 `存储桶` + 引导 `从顶栏切换 Bucket 或在左侧选择`。与子段 `[bucket]/[[...prefix]]` 共存（Next.js App Router 允许同级 `page.tsx` + 子动态段）。 |
| `/buckets/[bucket]/[[...prefix]]` | 仅文案中文化（Sub-spec 2 才改概览页） |
| `/shares` | 仅文案中文化 |
| `/audit` | 仅文案中文化 |
| `/connections` | **新增** `app/(dashboard)/connections/page.tsx`，从 `settings/connections/page.tsx` 复制内容 |
| `/settings/connections` | 改为 `redirect('/connections')`（Next.js server `redirect()`） |
| `/settings` | **新增** `app/(dashboard)/settings/page.tsx`：标题 `设置` + 占位说明 `更多设置项即将上线` |

`HomeRedirector` 改造：现有的 `pick-home-route.ts` 已经按 activeBucket 决定路径，改为永远先到 `/dashboard`，除非有 `callbackUrl`。

## 6. 文件改动清单

### 6.1 新建

- `components/features/dashboard/theme-switcher.tsx`（popover 用 shadcn 的 `DropdownMenu`，已存在 `components/ui/dropdown-menu.tsx`）
- `components/features/dashboard/user-menu.tsx`（同上）
- `lib/i18n/common.ts`
- `lib/i18n/error-messages.ts`
- `app/(dashboard)/dashboard/page.tsx`
- `app/(dashboard)/buckets/page.tsx`
- `app/(dashboard)/settings/page.tsx`
- `app/(dashboard)/connections/page.tsx`

### 6.2 重写

- `components/layout/app-shell.tsx`（新结构：网格 + 顶栏 + 侧栏）
- `components/features/dashboard/bucket-switcher.tsx`（已存在但功能是 connection 切换；改造为顶栏 bucket 切换器）
- `components/features/dashboard/home-redirector.tsx`（默认去 dashboard）

### 6.3 改文案 + 改 token 引用（不动逻辑）

- `app/(auth)/login/page.tsx`
- `app/(dashboard)/layout.tsx`
- `app/(dashboard)/shares/page.tsx`
- `app/(dashboard)/audit/page.tsx`
- `app/(dashboard)/buckets/[bucket]/[[...prefix]]/page.tsx`
- `components/features/connections/*.tsx`（5 个文件）
- `components/features/files/*.tsx`（4 个文件）
- `components/features/share/share-dialog.tsx`
- `components/features/upload/*.tsx`（4 个文件）
- `components/features/dashboard/sign-out-button.tsx`、`logo.tsx`
- `app/globals.css`（**替换** token 表 + 删除 dark）
- `app/layout.tsx`（删 Google Fonts import、新增 FOUC 防护 script、`<html data-theme>` 默认值）

### 6.4 改路由

- `app/(dashboard)/settings/connections/page.tsx`：改为 `redirect('/connections')`

## 7. 测试

### 7.1 Vitest 单测

- `tests/unit/i18n/error-messages.test.ts` — 已知 code 走映射、未知 code 走 `操作失败（<code>）` 兜底
- `tests/unit/dashboard/pick-home-route.test.ts` — 验证新逻辑（dashboard-first 除非 callbackUrl）
- `tests/unit/features/dashboard/theme-switcher.test.tsx` — 渲染三行、点击调用 `setTheme`（mock `useTheme` from next-themes；需 jsdom 环境 + `@testing-library/react`）

主题切换器测试需要 jsdom 与 React testing library，当前 `vitest.config.ts` 只有 `environment: "node"` 且 `include: ["tests/unit/**/*.test.ts"]`（无 `.tsx`）。实施时需：
1. 安装 `@testing-library/react` 与 `@testing-library/jest-dom`
2. 改 `vitest.config.ts`：把 `include` 改为 `["tests/unit/**/*.test.{ts,tsx}"]`；把 `environment` 改为 `"jsdom"`（或对组件测试单独用 `// @vitest-environment jsdom` 指令）

### 7.2 手动验收清单

- [ ] `pnpm preview` 起服务（:8788）：登录页全中文（含占位符 `请输入邮箱`、`请输入密码`），错误提示中文
- [ ] 登录后默认落地 `/dashboard`（无 callbackUrl 时）
- [ ] 顶栏左侧 `[CONN | <bucket> ▾]`，dropdown 列当前 connection 下的全部 bucket
- [ ] 顶栏右侧主题切换 pill + 用户 pill（含邮箱、popover 内"退出登录"）
- [ ] 三主题切换：点击经典蓝 → 活力橙 → 清新绿，所有页面 token 跟随；F5 刷新主题保持；shadcn 按钮/表格/输入框/弹窗边框/焦点环全部跟随
- [ ] 侧栏 6 项中文，"存储桶"下 bucket 二级列表常驻展开，活跃 bucket 高亮
- [ ] 点 `/connections` 显示连接管理列表（与原 `/settings/connections` 一致）；访问 `/settings/connections` 自动跳到 `/connections`
- [ ] `/settings` 显示占位页
- [ ] 全部 32 处 placeholder / aria-label 中文化
- [ ] DevTools Network 无 fonts.googleapis 请求
- [ ] `pnpm typecheck && pnpm lint && pnpm test` 全绿
- [ ] grep `placeholder=".*[A-Za-z]"` 在 app/ 与 components/features/ 下无英文占位符（components/ui/ 例外）

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| shadcn 组件硬依赖 `--background`/`--foreground` 等命名 → 桥接 `@theme inline` 没生效 | 第一次实施先只换 token + 桥接 + 单页面（登录页）验证；不一次性全替换 |
| FOUC：刷新瞬间 `<html>` 没 data-theme，闪默认主题 | 用 next-themes（已装），其 `ThemeProvider` 在 `<head>` 自动注入 inline script，零代码即可防 FOUC |
| 现有 `app-shell.tsx` 重写改动大，可能引入回归 | 在新文件 `app-shell.tsx` 内直接重写并完整跑过手动验收清单；保留旧文件 1 个 commit 周期便于回滚（PR 合并前删） |
| 路由 `/settings/connections` → `/connections` redirect 漏掉外链书签 | 用 Next.js server `redirect()` 而非客户端 push，SSR 时立即跳 |
| Vitest 缺少 jsdom 环境跑 React 组件测试 | 改 `vitest.config.ts` 加 jsdom + 装 `@testing-library/react`，详见 §7.1 |

## 9. 提交策略

按 Conventional Commits 拆 6 个原子 commit，单 PR 推进：

1. `chore(theme): replace oklch dark/light tokens with three light themes`
2. `feat(theme): add theme switcher pill with localStorage persistence`
3. `refactor(layout): rebuild app shell with bucket switcher and 6-item sidebar`
4. `feat(routes): add /dashboard /settings /connections placeholders, redirect /settings/connections`
5. `i18n(ui): localize all UI strings to simplified chinese`
6. `chore(fonts): remove google fonts import, use system chinese font stack`

## 10. Definition of Done

- [ ] 全部 7.2 手动验收清单打勾
- [ ] 全部 7.1 Vitest 单测通过
- [ ] `pnpm typecheck && pnpm lint && pnpm test` 三件套全绿
- [ ] 三套主题在登录页 + 仪表盘 + 存储桶 + 分享链接 + 审计日志 + 连接管理 + 设置 7 个页面均无视觉错误
- [ ] commit 历史按 §9 提交策略分 6 个 commit
- [ ] 用 `update_subtask` 记录每个 commit 的决策与遇到的坑
