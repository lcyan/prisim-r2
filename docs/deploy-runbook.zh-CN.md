[English](./deploy-runbook.md) | 中文

# 部署 Runbook

从干净的代码克隆到上线 Cloudflare Pages 部署的逐步操作。

## 0. 前置条件

- `pnpm` (Node 22 LTS 或更新版本)。
- `wrangler` 已通过你的 Cloudflare 账户认证
  (每台工作站执行一次 `wrangler login`)。
- 至少对一个 R2 存储桶拥有读写权限的 R2 access token。
  Prisim 不会创建桶 —— 先在控制台里挑一个已有的桶,或者先建一个。
- 如果你打算跑 E2E 套件,再准备一个一次性的 R2 桶。

## 1. 安装依赖并生成加密密钥

```bash
pnpm install
pnpm test:e2e:install     # 一次性:下载 Playwright 需要的 Chromium

# 用于 AES-GCM 凭据加密的 32 字节主密钥。
# 把它当数据库密码对待。丢了它会让所有现存的 connections 行都解不开;
# 轮换它需要把每一条 connections 行重新加密
# (见 CLAUDE.md 中的 "Rotating ENCRYPTION_KEY")。
openssl rand -base64 32
```

复制打印出的值。把它存进密码管理器 —— 本地的 `.dev.vars` 和
Cloudflare Pages 生产环境变量都要用。

## 2. 配置本地环境变量

在仓库根目录创建 `.dev.vars` (已在 gitignore 中):

```bash
AUTH_SECRET=$(openssl rand -base64 48)
AUTH_URL=http://localhost:8788
ENCRYPTION_KEY=<上面生成的 base64 值>
NEXT_PUBLIC_APP_URL=http://localhost:8788
```

`AUTH_SECRET` 和 `ENCRYPTION_KEY` 不是同一个东西。`AUTH_SECRET`
用来签 Auth.js 的 JWT;`ENCRYPTION_KEY` 在静态存储层包裹 R2 access key。
`AUTH_SECRET` 泄漏会让攻击者伪造会话;`ENCRYPTION_KEY` 泄漏会暴露
所有已存储的 R2 凭据。两者都按生产级机密对待。

## 3. 创建 D1 数据库 (仅首次)

```bash
wrangler d1 create prisim-r2-db
```

把返回的 `database_id` UUID 复制进 `wrangler.toml`,替换掉
`00000000-...` 占位符。

## 4. 应用迁移

```bash
pnpm db:migrate:local
```

这条命令把 `drizzle/migrations/` 下的所有 SQL 文件依次应用到本地的
D1 模拟器 (`.wrangler/state/v3/d1/`)。同一条命令用
`pnpm db:migrate:prod` 即可作用于远端 D1 —— 但务必先把生产环境变量
配置好(第 7 步)再跑,顺序不能反。

## 5. 种入管理员账号

Prisim 没有注册界面。管理员账号通过脚本创建:

```bash
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='at-least-12-chars' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql

wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql
```

脚本会把 INSERT 语句打印到 stdout,这样你可以在应用之前审计哈希值。
生产环境换成 `--remote` 重跑,并选择更强的密码 —— 脚本要求 ≥ 12 字符,
但不校验熵值。

## 6. 本地冒烟测试

```bash
pnpm preview
```

这条命令先跑 `next-on-pages` (Cloudflare Pages 构建产物),然后用
`wrangler pages dev` 监听 8788 端口。打开 http://localhost:8788,
用第 5 步的凭据登录。控制面板会跳转到一个空的连接列表页;
用你那个一次性 R2 桶的凭据新增一个连接,以验证完整的
加密 → 解密 → R2 探活流程。

> **注意:** `pnpm dev` (即 `next dev`) 不会绑定 D1 —— 任何打到
> `/api/*` 的请求都会返回 500。需要走 API 时一律使用 `pnpm preview`。

## 7. 配置 Cloudflare Pages 项目

进入 Cloudflare 控制台 → Workers & Pages → Create application →
Connect a Git repository → Build configuration:

- 构建命令: `pnpm install --frozen-lockfile && pnpm build:pages`
- 构建产物: `.vercel/output/static`
- Node 版本: 22
- 环境变量 (Production 和 Preview 都要设):
  - `AUTH_SECRET`
  - `AUTH_URL` (Pages 域名,例如 `https://prisim.example.com`)
  - `ENCRYPTION_KEY`
  - `NEXT_PUBLIC_APP_URL` (与 AUTH_URL 相同)
- Bindings → D1 database: 将 `DB` 绑定到第 3 步创建的数据库。

`NEXT_PUBLIC_*` 是构建期读取,不是运行期 —— 改了之后必须重新部署。

## 8. 应用远程迁移并种入生产管理员

```bash
pnpm db:migrate:prod
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='<生产环境的强密码>' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed-prod.sql
wrangler d1 execute prisim-r2-db --remote --file=/tmp/seed-prod.sql
```

## 9. 部署

环境变量和 binding 都齐了之后,从本地工作目录执行:

```bash
pnpm deploy
```

它会先跑 `next-on-pages` 再跑 `wrangler pages deploy`。CI 上的部署也
应当跑同样的两条命令 (`deploy` 脚本特意保持精简,可以安全地由
GitHub Actions 调用)。

第一次正式发布前先做一次 dry-run 自检:

```bash
pnpm exec wrangler pages deploy --dry-run
```

## 10. 应用每个 R2 桶的配置

对管理员将要通过 Prisim 浏览的每个桶都要做:

1. CORS —— 推荐的 JSON 见 `docs/r2-cors.zh-CN.md`。每个需要被控制面板
   源上传/下载的桶各应用一次。
2. 分片上传生命周期规则 —— `AbortIncompleteMultipartUpload` 规则见
   `docs/multipart-cleanup.zh-CN.md`。对会上传 >5 MB 文件的桶各应用一次。

不做 (1) 上传会在浏览器 CORS 层就失败,UI 拿不到有用的错误。
不做 (2) 被遗弃的分片会悄悄堆积,账单会被拉高。

## 11. 可选:在本次部署上运行 E2E 套件

```bash
export E2E_BASE_URL=https://prisim.example.com
export E2E_ADMIN_EMAIL=you@example.com
export E2E_ADMIN_PASSWORD='<生产管理员密码>'
export E2E_R2_ACCOUNT_ID=<你的 32 位 R2 account id>
export E2E_R2_ACCESS_KEY=<拥有读写权限的 R2 access key>
export E2E_R2_SECRET_KEY=<对应的 secret>
export E2E_R2_BUCKET=<一个可以让脚本随意写入的一次性 R2 桶>
export E2E_NO_WEBSERVER=1   # 不要启动本地 wrangler,我们打的是生产

pnpm test:e2e
```

请使用一个 _独立于_ 真实负载的管理员账号和桶 —— 每个 spec 都会作为
执行过程的一部分创建并删除对象/连接/分享。

## 轮换 ENCRYPTION_KEY

把这个密钥视为不可变的,除非真的必须换。要换的时候:

1. 生成新密钥。
2. 写一个重加密脚本:对每一条 `connections` 行,用旧密钥解密,
   再用新密钥加密 (两侧的 AAD 都还是该行的 `id`)。
3. 在生产环境仍配置旧密钥的状态下应用脚本。
4. 把环境变量切换到新密钥。
5. 重新部署。

跳过第 2 步会让每一条连接都不可读,所有 R2 调用会静默失败。
除非恢复旧密钥,否则没有别的找回手段。
