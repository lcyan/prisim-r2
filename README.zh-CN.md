[English](./README.md) | 中文

# Prisim R2

用于管理一个或多个 Cloudflare R2 存储桶的 Web 控制面板 ——
浏览、上传(大文件走分片)、通过预签名 URL 下载、需键入确认的删除,
以及带 TTL 的分享链接。V1 为单用户;数据库 schema 已经按多用户模型设计,
V2 将无须迁移即可解除单用户限制。

## 技术栈概览

- **框架**: Next.js 15 App Router + React 19 + TypeScript 严格模式
- **UI**: Tailwind CSS v4 + shadcn/ui (`new-york` 风格,stone 基色)
- **数据**: TanStack Query v5 (服务端状态) + Zustand v5 (UI 状态)
- **数据库**: Cloudflare D1 (SQLite),通过 Drizzle ORM
- **认证**: Auth.js v5 Credentials provider + 自研 D1 adapter
- **R2 SDK**: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- **部署**: Cloudflare Pages (`next-on-pages`)
- **测试**: Vitest (单元) + Playwright (E2E)

完整的架构说明,包括安全不变量和每次请求的生命周期,见
[`CLAUDE.md`](./CLAUDE.md)。

## 快速开始

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 然后填入实际值
pnpm db:migrate:local

# 种入唯一的管理员账号
ADMIN_EMAIL=me@example.com ADMIN_PASSWORD='at-least-12-chars' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql
wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql

pnpm preview     # http://localhost:8788
```

裸 `pnpm dev` (next dev) 故意不带 D1 binding,因此 `/api/*` 会返回 500。
做全栈开发时请始终使用 `pnpm preview`。

分步骤 runbook:

- **本地开发** (`.dev.vars`、本地 D1、种 admin、`pnpm preview`、TOTP
  重置): [`docs/local-dev.zh-CN.md`](./docs/local-dev.zh-CN.md)。
- **Cloudflare 部署** (Pages 项目配置、生产环境变量、远程 D1 迁移、
  生产管理员种入、`pnpm deploy`、`ENCRYPTION_KEY` 轮换):
  [`docs/deploy-cloudflare.zh-CN.md`](./docs/deploy-cloudflare.zh-CN.md)。

## 每个存储桶必须的配置

控制面板能上传/下载对象之前,每个桶都需要:

- **CORS 规则**,允许浏览器从控制面板源发起预签名 `PUT` 和 `GET` ——
  见 [`docs/r2-cors.zh-CN.md`](./docs/r2-cors.zh-CN.md)。
- **分片上传生命周期规则**,避免被遗弃的分片悄悄堆积成可计费存储 ——
  见 [`docs/multipart-cleanup.zh-CN.md`](./docs/multipart-cleanup.zh-CN.md)。

二者每桶一次,做完即可。跳过 CORS 会让上传在浏览器预检阶段失败,
并且 UI 看不到有用的错误提示;跳过生命周期规则则在收到 R2 账单之前
都不会被察觉。

## 测试

```bash
pnpm test                # vitest 单元测试
pnpm test:coverage       # 对 lib/** 做 v8 覆盖率统计
pnpm test:e2e:install    # 一次性:下载 Playwright 用的 Chromium
pnpm test:e2e            # 在 `pnpm preview` 上跑完整 Playwright 套件
```

E2E 套件需要真实的 R2 凭据。所需的 `E2E_*` 环境变量见
[`docs/deploy-cloudflare.zh-CN.md`](./docs/deploy-cloudflare.zh-CN.md#可选在部署上运行-e2e-套件)。
