# Dashboard 重设计:shadcn sidebar-07 + Tremor + 顶栏面包屑

**日期**:2026-05-24
**作者**:Claude(与 lcyan 协作 brainstorm)
**状态**:草案 · 待用户审阅
**前置背景**:Sub-spec 1(`2026-05-23-i18n-themes-shell-design.md`)落地了三主题 + 中文化 + 顶/侧栏对齐;在此之上,用户反馈"视觉风格不够专业、信息架构与导航不顺手"。本 spec 在保留三主题 token 的基础上,引入成熟的 dashboard 脚手架,重塑骨架与首页内容。

## 1. 范围与原则

### 1.1 在范围内

- 引入 shadcn 官方 sidebar block(sidebar-07 风格)替换手写的 CSS Grid AppShell
- 信息架构调整:顶栏面包屑承载 `connection / bucket / prefix`,侧栏改为 flat 主导航
- 引入 ⌘K 命令面板(cmdk)用于跳转和快捷动作
- 暗色模式:在现有三主色基础上增加 `data-mode="dark"`,共 6 套主题
- 引入 Tremor Raw 图表组件(`Card` / `AreaChart` / `BarChart` / `Tracker`)用于仪表盘首页
- `/dashboard` 从 placeholder 升级为实数据首页(KPI + 操作图表 + 最近活动)
- `/buckets` 从引导文案升级为 bucket 卡片列表
- 现有业务页面(audit / connections / files / shares / settings)零迁移,只跟随新壳

### 1.2 不在范围

- 全局搜索(对象/key 级别)、键盘快捷键面板、通知中心 → 后续 sub-spec
- bucket 子页(CORS / 自定义域名 / Lifecycle) → 仍属 Sub-spec 5
- Cloudflare Analytics API 接入(用户额外配 CF API token 才能拿到出口流量)→ V2
- 全 bucket 对象总数 / 总存储量(R2 无 fast count,代价过高)→ V2 用"按需扫描 + 24h 缓存"
- 移动端响应式深度优化 → 跟随 shadcn sidebar 默认行为即可,不额外定制

### 1.3 原则

- **业务逻辑零改动**:所有 API、auth、R2、加密、audit 写入保持原样,只重塑布局与首页
- **token 系统延续 Sub-spec 1**:三主色 + 通用 token 不动,新增的暗色 token 在 `:root[data-mode="dark"]` 一处统一管理
- **新组件优先 copy-in**:shadcn 用 CLI 生成进 `components/ui/`,Tremor 手动 copy 进 `components/charts/`,只新增 Recharts 一个 npm 运行时依赖
- **保留 `T = { ... } as const` 中文文案约定**:所有新组件遵循同样的文案块模式
- **每阶段独立可 commit、可回滚**:6 个 Phase 之间无强耦合

## 2. 脚手架引入

### 2.1 shadcn 组件

通过 CLI 一次性 add(都进 `components/ui/`,跟 new-york 风格已有组件并列):

```bash
pnpm dlx shadcn@latest add sidebar breadcrumb command sheet tooltip separator
```

新增组件:

| 组件 | 用途 |
|---|---|
| `sidebar.tsx` | `SidebarProvider` / `Sidebar` / `SidebarMenu` / `SidebarMenuButton` / `SidebarInset` / `SidebarTrigger` |
| `breadcrumb.tsx` | 顶栏面包屑 |
| `command.tsx` | ⌘K 命令面板(基于 cmdk) |
| `sheet.tsx` | 移动端侧栏抽屉(sidebar 自带依赖) |
| `tooltip.tsx` | 折叠侧栏的 hover label |
| `separator.tsx` | 侧栏分组分隔线 |

### 2.2 Tremor Raw 图表

不通过 npm 安装,而是从 https://raw.tremor.so/docs 手动 copy 源码到 `components/charts/`(Tremor Raw 设计为 copy-in,本质是 cn() + Radix + Recharts 包装):

```
components/charts/
  card.tsx
  area-chart.tsx
  bar-chart.tsx
  tracker.tsx
```

唯一 npm 新增依赖:

```bash
pnpm add recharts
```

预计 Recharts gzip 后 ~90KB。Phase 4 完成后跑一次 `pnpm build` 核对 `.vercel/output/static/_worker.js` 仍 < 1MB(Pages worker 上限)。若超出,把 `/dashboard` 改 dynamic import。

### 2.3 整体外壳替换

`components/layout/app-shell.tsx` 整体重写:

```tsx
<SidebarProvider defaultOpen={…}>
  <AppSidebar />
  <SidebarInset>
    <AppTopbar />
    {children}
  </SidebarInset>
  <CommandMenu />  {/* 全局,⌘K 触发 */}
</SidebarProvider>
```

废弃的旧 token(`--sidebar-w` / `--topbar-h` / `--row-h` / `--row-h-tight` / `.signal-bar`)从 `globals.css` 移除,由 shadcn sidebar 自带 CSS var 取代。

## 3. 信息架构与导航

### 3.1 顶栏(Topbar)

布局:

```
[☰] {connection-segment} / {bucket-segment} / {prefix-segment}      [⌘K]  [☼]  [👤]
```

- `[☰]` = `<SidebarTrigger />`,桌面切换展开/折叠,移动端打开 sheet
- 面包屑段根据 pathname 动态渲染:

| pathname | segments |
|---|---|
| `/dashboard` | `{conn} / 仪表盘` |
| `/buckets` | `{conn} / 存储桶` |
| `/buckets/[bucket]` | `{conn} / 存储桶 / {bucket}` |
| `/buckets/[bucket]/[...prefix]` | `{conn} / 存储桶 / {bucket} / {prefix...}`(prefix 可省略到 `…/last/`) |
| `/shares` | `{conn} / 分享链接` |
| `/audit` | `{conn} / 审计日志` |
| `/connections` | `连接管理` (不显示 conn 段,这本身就是 conn 管理页) |
| `/settings` | `设置` |

- `{connection-segment}` 点击打开 `<ConnectionSwitcher />` popover:列表 + "新建连接"按钮
- `{bucket-segment}` 点击打开 `<BucketSwitcher />` popover:当前 connection 下所有 bucket + "查看全部 bucket"链接
- `{prefix-segment}` 不可点,只展示当前路径

- `[⌘K]` 按钮:外形是 "搜索 · ⌘K" 的胶囊;点击或 `cmd/ctrl+K` 触发 `CommandDialog`
- `[☼]` 主题切换(见第 4 节)
- `[👤]` `<UserMenu />`(保留现状)

### 3.2 侧栏(Sidebar — sidebar-07 风格)

```
┌──────────────────┐
│ [P] Prisim R2    │  ← SidebarHeader (logo + brand)
├──────────────────┤
│ 主导航            │  ← SidebarGroupLabel
│ ▦ 仪表盘          │
│ ▥ 存储桶          │
│ ⤴ 分享链接        │
│ ⊟ 审计日志        │
├──────────────────┤
│ 设置              │  ← SidebarGroupLabel
│ ⊟ 连接管理        │
│ ⚙ 设置            │
└──────────────────┘
```

- flat,**不再有 bucket 二级展开**(bucket 切换由顶栏面包屑承担)
- 分两组:上组业务,下组管理,中间 `<Separator />`
- 折叠态:56px 图标条,hover 出 tooltip 显示中文标签;键盘 `[` 切换(shadcn 默认)
- `SidebarFooter`:**删除现有的"活动连接卡"**(connection 已在顶栏面包屑首段)
- 折叠状态用 cookie 持久化(shadcn sidebar 默认行为)

### 3.3 ⌘K 命令面板(`<CommandMenu />`)

V1 命令分组:

| Group | Items |
|---|---|
| **导航** | 仪表盘 / 存储桶 / 分享链接 / 审计日志 / 连接管理 / 设置 |
| **快捷动作** | 新建连接 / 切换主题 - 蓝 / 切换主题 - 橙 / 切换主题 - 绿 / 切换到暗色 / 切换到亮色 / 跟随系统 / 退出登录 |
| **跳转 bucket** | 当前 connection 下的所有 bucket(动态加载) |
| **切换连接** | 所有 connection(动态加载) |

- V2 再加:对象搜索(需后端索引)、最近访问、键盘 hint 显示
- `CommandDialog` 默认开关由全局 Zustand store 控制,`useHotkeys` 监听 `mod+k`

## 4. token 系统与暗色模式

### 4.1 二维主题:主色 × 模式

```
data-theme="blue"   data-mode="light"   ← 默认
data-theme="blue"   data-mode="dark"
data-theme="orange" data-mode="light"
data-theme="orange" data-mode="dark"
data-theme="green"  data-mode="light"
data-theme="green"  data-mode="dark"
```

- 模式负责"明/暗",影响背景/前景/边框/输入框/卡片底色
- 主色独立于模式,只影响 `--primary` 及其衍生 hover/active/soft

### 4.2 globals.css 结构

```css
/* 1. 通用 token(共享) */
:root {
  --fg: #1F2329; --fg-2: #4E5969; --muted: #86909C; …
  --content-bg: #F5F7FA; --surface: #FFFFFF; --border: #E5E6EB; …
  --success: #00B42A; --warning: #FF7D00; --danger: #F53F3F; …
  --radius: 6px; --shadow-sm: …; --font-sans: …;
}

/* 2. 主色:三套 */
:root[data-theme="blue"]   { --primary: #1677FF; --primary-hover: #4391FF; … }
:root[data-theme="orange"] { --primary: #FF6A00; --primary-hover: #FF8A33; … }
:root[data-theme="green"]  { --primary: #00B96B; --primary-hover: #2FCD8A; … }

/* 3. 暗色模式覆盖:语义层(背景/前景/边框) */
:root[data-mode="dark"] {
  --content-bg: #0B0D11;
  --surface:    #14171C;
  --fg:         #E6E7EA;
  --fg-2:       #B0B4BB;
  --muted:      #6B7280;
  --border:     #1F2229;
  --border-strong: #2A2E36;
  --row-hover:  #1A1D23;
  --code-bg:    #14171C;
  --shadow-sm:  0 1px 2px rgba(0,0,0,0.4);
  --shadow-md:  0 4px 14px rgba(0,0,0,0.5);
  --shadow-lg:  0 24px 60px rgba(0,0,0,0.7);
}

/* 4. 暗色 × 各主色:微调 primary 在深底上的对比度 + primary-soft */
:root[data-theme="blue"][data-mode="dark"] {
  --primary: #4391FF;
  --primary-soft: rgba(67, 145, 255, 0.14);
  --primary-soft-strong: rgba(67, 145, 255, 0.22);
}
:root[data-theme="orange"][data-mode="dark"] {
  --primary: #FF8A33;
  --primary-soft: rgba(255, 138, 51, 0.14);
  --primary-soft-strong: rgba(255, 138, 51, 0.22);
}
:root[data-theme="green"][data-mode="dark"] {
  --primary: #2FCD8A;
  --primary-soft: rgba(47, 205, 138, 0.14);
  --primary-soft-strong: rgba(47, 205, 138, 0.22);
}

/* 5. shadcn ↔ token 桥接(已存在,不改) */
@theme inline { ... }
```

### 4.3 next-themes + 独立 ModeProvider 配置

主色 (`data-theme`) 仍由 `next-themes` 单 attribute 管理(沿用 Sub-spec 1 配置不动);模式 (`data-mode`) 由**独立**的 `ModeProvider`(自建,基于 zustand)管理。两者完全解耦,互不覆盖。

```tsx
// components/providers.tsx
<NextThemesProvider
  attribute="data-theme"
  defaultTheme="blue"
  themes={['blue','orange','green']}
  enableSystem={false}   // 主色不存在"系统色",关闭
>
  <ModeProvider>
    {children}
  </ModeProvider>
</NextThemesProvider>
```

`ModeProvider` 职责:
- 状态来自 `useUiStore`(见第 7.2 节),持久化到 `localStorage["prisim-mode"] ∈ {"light","dark","system"}`
- 客户端挂载后,读取持久化值;若是 `"system"`,监听 `matchMedia('(prefers-color-scheme: dark)')`
- 把当前模式写到 `<html data-mode="light"|"dark">`(`"system"` 时根据 matchMedia 结果展开)
- SSR 时 `<html>` 不带 `data-mode`,避免水合不一致;首次 paint 用默认 light(blink 极短可接受,或后续加 `next-themes` 风格的预加载 script)

### 4.4 ThemeSwitcher 改造

`components/features/dashboard/theme-switcher.tsx` 改为 dropdown 含两组:

```
主色
  ● 经典蓝
  ○ 活力橙
  ○ 清新绿

外观
  ○ 亮色
  ○ 暗色
  ● 跟随系统
```

## 5. 仪表盘首页(`/dashboard`)

### 5.1 内容(V1 范围)

四张 KPI 卡(全部从 D1 即时拿):

| 卡片 | 数据 | 来源查询 |
|---|---|---|
| Bucket 数 | 当前 connection 的 bucket 数量 | R2 `ListBuckets`(已 cached by TanStack Query) |
| 活跃分享 | `count(*) from shares where expires_at > now()` + 7 天内过期细分 | D1 |
| 30 天操作 | `count(*) from audit_log where created_at > now()-30d` + delta vs 上 30 天 | D1 |
| 30 天失败率 | `count(*) where status='failure'` / 总数 | D1 |

两个图表:

| 图表 | 类型 | 数据 |
|---|---|---|
| 操作量 · 30 天 | Tremor `AreaChart` 按天聚合 | `audit_log group by date(created_at)` |
| 操作类型分布 · 7 天 | Tremor `BarChart` 横向 / 自定义 progress bar | `audit_log group by op where created_at > now()-7d` |

最近活动列表:`audit_log order by created_at desc limit 10`,UI 复用现有 `/audit` 行的精简版(时间 / op badge / bucket / key)。

顶部右侧区间切换器:`7 天 / 30 天`,影响下方图表与"30 天"标签的 KPI 卡(切换后 label 也变 7 天)。

### 5.2 API 设计

**新建** `app/api/dashboard/summary/route.ts`:

```ts
export const runtime = "edge";

export const GET = withApi(
  async (req, ctx) => {
    const { searchParams } = new URL(req.url);
    const input = DashboardSummaryQuerySchema.parse({
      connectionId: searchParams.get("connectionId"),
      range: searchParams.get("range") ?? "30d",
    });
    return getDashboardSummary(input, ctx); // 自动包装为 Response.json(...)
  },
  { rateLimit: ({ ctx }) => RateLimitBundles.dashboardSummaryByUser(ctx.userId) }
);
```

**新增限流 bundle** `lib/api/rate-limit.ts`:

```ts
// 新增 policy
dashboardSummaryByUser: (userId: string) => ({
  key: `dashboard:summary:${userId}`,
  limit: 60,
  windowSec: 60,           // 60 / min, 与 PRD §6 读类风格一致
}),

// 新增 bundle (仅一条 policy,因为只有 read 类总额限制)
dashboardSummaryByUser: (userId: string): RateLimitPolicy[] => [
  RateLimitPolicies.dashboardSummaryByUser(userId),
],
```

`lib/api/schemas.ts` 新增:

```ts
export const DashboardSummaryQuerySchema = z.object({
  connectionId: z.string().min(1),
  range: z.enum(["7d", "30d"]).default("30d"),
});
export type DashboardSummaryQuery = z.infer<typeof DashboardSummaryQuerySchema>;
```

`lib/api/types.ts` 新增:

```ts
export interface DashboardSummary {
  bucketsCount: number;
  shares: { active: number; expiring7d: number };
  ops: { count: number; deltaPct: number };       // delta vs 上一个等长窗口
  failures: { count: number; ratePct: number };
  opsByDay: Array<{ date: string; count: number }>;          // YYYY-MM-DD
  opsByType: Array<{ op: AuditOp; count: number }>;          // 7d
  recentActivity: Array<AuditEntry>;                          // 10 条
}
```

`lib/dashboard/summary.ts`(server-only):并发 6 个 D1 query,500ms 内返回,响应大小 < 2KB。

### 5.3 hooks

```ts
// hooks/use-dashboard.ts
export const DASHBOARD_QUERY_KEY = (connectionId: string, range: "7d"|"30d") =>
  ['dashboard', connectionId, range] as const;

export function useDashboardSummary(connectionId, range) { … }
```

失效条件:任何 audit 写入(`useAudit` 的 mutation success)→ `invalidateQueries(['dashboard'])`。

## 6. 业务页面改造范围

| 页面 | 现状 | 动作 |
|---|---|---|
| `/dashboard` | placeholder | **全新内容**(本 spec 第 5 节) |
| `/buckets` | placeholder | **改为 bucket 列表卡片页**,shadcn `<Card>` grid,每张卡:bucket 名 + 创建时间 + "进入"按钮 |
| `/buckets/[bucket]/[[...prefix]]` | 对象浏览表 + 自有 breadcrumb | **保留对象表**,删除 `components/features/files/breadcrumb.tsx`(顶栏面包屑接管 prefix 段) |
| `/audit` | 完整 | **零内容改动**,只跟随新壳 |
| `/connections`(= `/settings/connections`) | 完整 | **零内容改动** |
| `/shares` | 完整 | **零内容改动** |
| `/settings` | 入口页 | **新增页眉 tabs**:连接管理(已有)/ 个人偏好 / 关于;后两项 V2 占位 |

## 7. 文件结构变化

### 7.1 新增

```
components/layout/
  app-sidebar.tsx                ← Sidebar 主导航 + 分组
  app-topbar.tsx                 ← 面包屑 + ⌘K + 主题 + 用户
  command-menu.tsx               ← CommandDialog
  topbar-breadcrumb.tsx          ← 根据 pathname 动态渲染 segments

components/features/dashboard/
  connection-switcher.tsx        ← 新增,顶栏 connection 段 popover
  kpi-card.tsx                   ← KPI 卡(数字 + label + delta badge)
  ops-area-chart.tsx             ← Tremor AreaChart 包装
  ops-by-type-bar.tsx            ← 操作类型分布
  recent-activity.tsx            ← 最近活动列表
  range-toggle.tsx               ← 7d / 30d 切换

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

app/api/dashboard/
  summary/route.ts
```

### 7.2 改造

```
components/layout/app-shell.tsx       ← 整体重写
components/features/dashboard/bucket-switcher.tsx  ← 从顶栏组件改为面包屑 popover
components/features/dashboard/theme-switcher.tsx   ← 双维 dropdown
components/features/dashboard/logo.tsx             ← 适配 SidebarHeader 折叠态
components/providers.tsx                           ← ThemeProvider 双 attribute + ModeProvider
app/(dashboard)/dashboard/page.tsx                 ← 全新内容
app/(dashboard)/buckets/page.tsx                   ← bucket 卡片列表
app/(dashboard)/settings/page.tsx                  ← 加 tabs
app/globals.css                                    ← 新增 dark 模式 token,删除废弃布局原语
lib/api/schemas.ts                                 ← 新增 DashboardSummaryQuerySchema
lib/api/types.ts                                   ← 新增 DashboardSummary
lib/api/rate-limit.ts                              ← 新增 dashboardSummaryByUser policy + bundle
stores/ui-store.ts                                 ← 新增:命令面板开关 + 模式(light/dark/system)持久化
```

### 7.3 删除

```
components/features/files/breadcrumb.tsx           ← 顶栏面包屑接管
```

## 8. 迁移计划(6 个 Phase)

| Phase | 主题 | 主要变更 | 验收 |
|---|---|---|---|
| **1** | 脚手架引入 | shadcn add 6 个组件;重写 app-shell.tsx 用 SidebarProvider;新建 app-sidebar/app-topbar/command-menu(暂用占位面包屑);删除 sidebar bucket 二级 + 活动连接卡 | 6 个现有页面可打开,视觉骨架就位 |
| **2** | 顶栏面包屑 IA | 改造 bucket-switcher 为面包屑 popover;新建 connection-switcher;topbar-breadcrumb 路由感知;删除 files/breadcrumb.tsx | 切 connection/bucket/prefix 都从顶栏走 |
| **3** | 暗色模式 + 二维主题 | 新增 `ModeProvider`(基于 `useUiStore`);globals.css 加 dark token;ThemeSwitcher 双维 | 6 套主题切换正确 + localStorage 持久化 |
| **4** | Tremor + 图表基建 | pnpm add recharts;copy Tremor Raw 4 个文件;新建 kpi-card / ops-area-chart / ops-by-type-bar / recent-activity / range-toggle | 在 sandbox route 临时挂载验证;`pnpm build` bundle < 1MB |
| **5** | 仪表盘 API + 首页 | `lib/api/rate-limit.ts` 加 `dashboardSummaryByUser`(60/min/user);schemas + types + route + hook + page;dashboard summary D1 queries | `/dashboard` 渲染真实数据 |
| **6** | /buckets 卡片化 | 重写 `/buckets/page.tsx` 为 Card grid | bucket 列表卡可点击进入 |

**回滚策略**:每 Phase 独立 commit,`git revert <sha>` 即可单独回滚,Phase 间无强耦合。

**外部依赖前置确认**(Phase 1 起手时验证):
1. `pnpm dlx shadcn@latest add sidebar` 在 Tailwind v4 + new-york 配置下产出可用文件
2. Tremor Raw `area-chart.tsx` 源码能直接用 Tailwind v4 `@theme` 语义类
3. Recharts 在 edge runtime 下需 `"use client"`(预期是)

## 9. 测试要求

按 CLAUDE.md DoD:

| Phase | Vitest 单元 |
|---|---|
| 1 | `app-shell.test.tsx`(SidebarProvider 渲染、folding cookie 持久化) |
| 2 | `topbar-breadcrumb.test.ts`(pathname → segments 映射、各路径覆盖)<br>`connection-switcher.test.tsx`(空连接/单连接/多连接)<br>`bucket-switcher.test.tsx`(已选/未选/列表加载中) |
| 3 | `theme-switcher.test.tsx`(主色与模式互不干扰、persist 双 key)<br>`mode-store.test.ts`(system / light / dark 切换) |
| 4 | `format-delta.test.ts`(prev=0、curr=0、负数、∞%)<br>`kpi-card.test.tsx`(渲染 delta badge 颜色) |
| 5 | `app/api/dashboard/summary/route.test.ts`(happy / 未登录 / 错 connectionId / limiter 触发 / D1 失败)<br>`lib/dashboard/summary.test.ts`(mock D1 binding,验证 6 路 query 并发、空表 → 默认值、聚合数学正确) |
| 6 | `app/(dashboard)/buckets/page.test.tsx`(0/1/多 bucket、加载、错误) |

**E2E**:不引入,本 spec 范围内无跨页面 / 真实浏览器才能验的交互。Playwright 仍维持"未配置"状态,推迟到真正需要时。

**performance / bundle 检查**:Phase 4 与 Phase 5 完成后各跑一次:

```bash
pnpm build:pages
ls -lh .vercel/output/static/_worker.js  # 应 < 1MB
```

若超出,把 `/dashboard` 改 `next/dynamic` 拆 chunk,KPI 卡保留在同步 chunk,图表 lazy。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Recharts SSR 限制 | Recharts 图表所在文件 `"use client"`,内容包在 `<Suspense>` 里;不在 server component 渲染 |
| Pages worker bundle 超 1MB | Phase 4/5 各核对一次;超限时 dashboard 改 dynamic import |
| shadcn sidebar 在 Tailwind v4 不兼容 | Phase 1 第一步实测;退路:回退到手写 + 复用现有 token 系统(放弃 sidebar block) |
| Tremor Raw 与 v4 语义类冲突 | Phase 4 实测;退路:用 shadcn 官方 chart block(Recharts 直包) |
| dashboard summary D1 查询慢 | 6 query 并发 + EXPLAIN QUERY PLAN 检查索引;`audit_log(user_id, created_at)` 已有联合索引,确认 `(user_id, op, created_at)` 复合索引足够 |
| dark 主题色对比度未达 WCAG AA | 用 WebAIM contrast checker 核对 3 个 primary 在 #0B0D11 上的对比度,不足时把 light shade 进一步提亮 |
| next-themes 双 attribute 冲突 | 主色用 next-themes 单 attribute 管,模式用独立 `ModeProvider`(zustand 驱动)直接写 `<html data-mode>`,两者不相互覆盖 |

## 11. 与 Sub-spec 1 的关系

Sub-spec 1 落地了:
- 中文文案、`T = {…} as const` 模式
- 三主色 token + 通用 token + shadcn ↔ token 桥接(`@theme inline`)
- 顶栏 BucketSwitcher、ThemeSwitcher、UserMenu;侧栏 6 项 + bucket 二级展开 + 活动连接卡
- 路由 `/dashboard`、`/buckets`、`/connections`、`/settings` 等占位

本 spec **保留** Sub-spec 1 的所有 token、文案约定、路由结构,**重塑**:
- Sub-spec 1 的手写 AppShell(grid template) → SidebarProvider
- Sub-spec 1 的"顶栏 BucketSwitcher" → 顶栏面包屑 bucket 段(组件复用,容器变化)
- Sub-spec 1 的"侧栏 bucket 二级展开" → 移除(顶栏面包屑承担)
- Sub-spec 1 的"侧栏活动连接卡" → 移除(冗余)
- Sub-spec 1 的"亮色 only" → 增加 dark 模式 token

新增:
- ⌘K 命令面板
- Tremor 图表
- `/dashboard` 真实内容
- `/buckets` 卡片列表
- `<ConnectionSwitcher />`

## 12. 附录:CLAUDE.md 规则对照

- ✅ 编辑现有 `app-shell.tsx`,不新建另一个 shell
- ✅ 新组件全部走 `shadcn add`(`components/ui/` 不手写) 或 copy-in(`components/charts/`)
- ✅ 业务逻辑零改动,credentials 加密、CSRF、限流、audit、edge runtime 全部不动
- ✅ 新 API 走 `withApi` + Zod + `ApiErrors` + `RateLimitBundles.read`
- ✅ 新增 D1 写入路径**没有**(只读 summary),无需新 audit op 类型
- ✅ Conventional Commits:本 spec 内的 commit 用 `feat(ui)` / `refactor(layout)` / `feat(dashboard)` / `feat(api)` 等
- ✅ 每阶段 Vitest 单测覆盖 happy + 至少一个 failure
- ✅ 不引入新 runtime 依赖除 Recharts(评估 bundle 大小后引入)
