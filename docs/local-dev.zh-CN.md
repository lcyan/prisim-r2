[English](./local-dev.md) | 中文

# 本地开发 Runbook

把 Prisim R2 在本地跑起来的全过程。如果你要部署到 Cloudflare,
先把本地跑通,再看 [`deploy-cloudflare.zh-CN.md`](./deploy-cloudflare.zh-CN.md)。

## 0. 前置条件

- `pnpm` (Node 22 LTS 或更新)。
- `wrangler` 已通过你的 Cloudflare 账户认证 (每台机器执行一次
  `wrangler login`)。本地开发也需要,因为 `pnpm preview` 跑的是
  Cloudflare Pages 模拟器。
- 一个 R2 access token,对至少一个 R2 桶有读写权限。Prisim 不会
  自己建桶 —— 先在 Cloudflare 控制台里挑一个已有的或者先建一个,
  并准备好它的 access key / secret。

## 1. 安装依赖并生成加密密钥

```bash
pnpm install

# 用于 AES-GCM 凭据加密的 32 字节主密钥。
# 把它当数据库密码对待。丢了它就再也解不开任何现存的
# connections 行;轮换它需要把每条 connections 行重新加密
# (见 CLAUDE.md 中的 "Rotating ENCRYPTION_KEY")。
openssl rand -base64 32
```

复制打印出的值。塞进密码管理器 —— 待会儿 `.dev.vars` 要用。
**本地的 key 和生产的 key 建议分开**,这样本地不小心泄漏不会
波及生产凭据。

## 2. 配置 `.dev.vars`

在仓库根目录新建 `.dev.vars` (已被 gitignore 忽略):

```bash
AUTH_SECRET=$(openssl rand -base64 48)
AUTH_URL=http://localhost:8788
ENCRYPTION_KEY=<上一步生成的 base64 值>
NEXT_PUBLIC_APP_URL=http://localhost:8788
```

`AUTH_SECRET` 和 `ENCRYPTION_KEY` 是两件不同的事。`AUTH_SECRET`
用来签 Auth.js 的 JWT;`ENCRYPTION_KEY` 在静态存储层包裹 R2
access key。两者都按生产级机密对待 —— 即便只在本地,泄漏的
`ENCRYPTION_KEY` 也意味着你存进本地 D1 的所有 R2 凭据都被暴露了。

## 3. 创建本地 D1 数据库 (首次)

```bash
wrangler d1 create prisim-r2-db
```

把返回的 `database_id` UUID 复制进 `wrangler.toml`,替换掉
`00000000-...` 占位符。这一步同时影响本地和生产 binding —— 因为
`wrangler.toml` 里只有一份配置。

> 注意:`wrangler d1 create` 会在 Cloudflare 远端建库。如果你
> 当前账号下已经有同名库,可以跳过 `create`,直接把现有库的
> `database_id` 写进 `wrangler.toml`。

## 4. 应用本地迁移

```bash
pnpm db:migrate:local
```

这条命令会把 `drizzle/migrations/` 下所有 SQL 依次应用到
本地的 D1 模拟器 (`.wrangler/state/v3/d1/`)。每次 `lib/db/schema.ts`
有变更并重新跑过 `pnpm db:gen` 之后,记得再跑一次本地迁移。

## 5. 种入管理员账号

Prisim 没有注册界面。管理员账号通过脚本插入:

```bash
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='at-least-12-chars' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql

wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql
```

脚本会把 INSERT 语句打印到 stdout,你可以先审计哈希值再
应用进数据库。

## 6. 启动本地开发服务

```bash
pnpm preview
```

这条命令先跑 `next-on-pages` 生成 Cloudflare Pages 构建产物,然后
用 `wrangler pages dev` 监听 8788 端口。打开
http://localhost:8788,用第 5 步种入的凭据登录。第一次登录会要求
你做 TOTP 绑定;扫码后回到控制面板 —— 应该跳转到一个空的连接
列表页。用你那个 R2 桶的 access key / secret 新增一个连接,以验证
完整的 加密 → 解密 → R2 探活 流程。

> **重要**: `pnpm dev` (即裸跑 `next dev`) 不会绑定 D1 ——
> 任何打到 `/api/*` 的请求都会返回 500。要走 API 就用 `pnpm preview`。
> 只在调样式 / 改纯 UI 时才考虑 `pnpm dev`。

## 7. (本地开发用真实桶时) 配置 R2 CORS

如果你想在本地直接对真实 R2 桶做上传/下载,需要把
`http://localhost:8788` 加进桶的 CORS `AllowedOrigins`。完整规则和
`wrangler` 命令见 [`r2-cors.zh-CN.md`](./r2-cors.zh-CN.md)。

只跑 Vitest 单元测试,或者只点击 UI 不实际触发上传时,可以跳过这一步。

## 8. 跑测试

```bash
pnpm test                # Vitest 单元测试
pnpm test:watch          # 监听模式
pnpm test:coverage       # 对 lib/** 做 v8 覆盖率统计
```

E2E (Playwright) 套件可选,首次跑要装浏览器:

```bash
pnpm test:e2e:install    # 一次性:下载 Playwright 用的 Chromium
pnpm test:e2e            # 默认对 `pnpm preview` 起的本地服务跑
```

E2E 需要真实的 R2 凭据。完整的 `E2E_*` 环境变量清单见
[`deploy-cloudflare.zh-CN.md` 的可选 E2E 章节](./deploy-cloudflare.zh-CN.md#可选在部署上运行-e2e-套件)。

## TOTP 重置 (忘记 Authenticator / 测试用)

强制 TOTP 已经是登录链路的一部分。本地测试时如果想清掉
TOTP 状态重新走一遍绑定流程:

```bash
wrangler d1 execute prisim-r2-db --local --command \
  "UPDATE users SET totp_enabled = 0, totp_secret_ciphertext = NULL, totp_secret_iv = NULL, totp_confirmed_at = NULL"
wrangler d1 execute prisim-r2-db --local --command \
  "DELETE FROM recovery_codes"
wrangler d1 execute prisim-r2-db --local --command \
  "DELETE FROM totp_replay_guard"
```

下次登录会重新跳到 `/setup/totp`。生产环境不要这样直接 SQL ——
要为用户走正常的恢复码流程,或者重新种 admin。

## 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 登录返回 500,响应里有 `D1_ERROR: no such table` | 没跑 `pnpm db:migrate:local`,或者 `wrangler.toml` 里 `database_id` 还是占位符 |
| 登录页加载但 `/api/csrf` 报 500 | 多半是在跑 `pnpm dev` 而不是 `pnpm preview` |
| 上传立刻失败 / 网络面板看不到 PUT | 桶的 CORS 没加 `http://localhost:8788`,见第 7 步 |
| 新增 connection 时返回 `crypto.*` 错误 | `.dev.vars` 里的 `ENCRYPTION_KEY` 不是合法的 base64,或者少于 32 字节 |
