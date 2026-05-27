[English](./deploy-cloudflare.md) | 中文

# Cloudflare 部署 Runbook

把 Prisim R2 部署到 Cloudflare Workers 的全过程 (通过
`@opennextjs/cloudflare`)。

**前置**:先按 [`local-dev.zh-CN.md`](./local-dev.zh-CN.md) 把
本地跑通,确保你已经有:

- 安装好的 `pnpm` 和已经认证过的 `wrangler`
- 一个 R2 access token (生产专用,和本地隔离)
- 一个本地 .dev.vars 已经验证过 加密 → 解密 → R2 探活 全流程

下面的步骤都是 _生产侧_ 的配置。本地的 `.dev.vars` 不会动。

## 0. 生成生产专用密钥

```bash
# 生产环境的 AUTH_SECRET (Auth.js JWT 签名)
openssl rand -base64 48

# 生产环境的 ENCRYPTION_KEY (R2 凭据 AES-GCM 主密钥)
openssl rand -base64 32
```

两个值都立刻塞进密码管理器。**不要复用本地 `.dev.vars` 的值** ——
本地与生产共享密钥意味着任意一边泄漏都波及对方;而且本地很可能
不小心被 commit 到工作日记/截图。

把这两个值视为不可变。`ENCRYPTION_KEY` 一旦投产就基本不能换 ——
换的话要把所有 `connections` 行重新加密,细节见本文最后 "轮换
`ENCRYPTION_KEY`" 一节。

## 1. 准备 Cloudflare 上的资源

首次部署需要 Cloudflare 侧具备三样东西:一个 Worker 槽位 (首次跑
`wrangler deploy` 时自动创建)、一个 D1 数据库,以及把 `name` /
`database_id` 写进 `wrangler.toml`。

```bash
# 创建生产 D1 库。如果账号下已有同名库就跳过。
wrangler d1 create prisim-r2-db
```

打开 `wrangler.toml` 确认:

- `name = "prisim-r2"` 是你要部署的 Worker 名字 —— 想用别的名字
  就改这里。
- `[[d1_databases]]` 的 `database_name` 是 `prisim-r2-db`,
  `database_id` 是 `wrangler d1 create` 返回的 UUID (或者复用现有
  库的 UUID)。改动后提交。

## 2. 配置生产 secrets

Workers 把生产环境变量当作 **Worker secrets** (静态加密) 存,通过
`wrangler secret put` 一条一条设。从仓库根目录跑,这样 wrangler
能读到 `wrangler.toml`:

```bash
wrangler secret put AUTH_SECRET            # 粘贴第 0 步生成的 48 字节 base64
wrangler secret put AUTH_URL               # Workers 完整 URL,如 https://prisim.example.com
wrangler secret put ENCRYPTION_KEY         # 粘贴第 0 步生成的 32 字节 base64
wrangler secret put NEXT_PUBLIC_APP_URL    # 同 AUTH_URL
```

每条命令会提示输入一次值。`wrangler secret list` 可以列出已配
名字而不打印值,方便核对。

> `NEXT_PUBLIC_*` 是构建期读取的,不是运行期。改了之后必须重新
> 跑一次 `pnpm deploy` 才能进 bundle 生效。

> D1 binding (`DB`) 写在 `wrangler.toml`,每次 `wrangler deploy`
> 都会自动应用 —— 不需要去 Cloudflare 控制台里手动配 D1。

## 3. 应用远程 D1 迁移

```bash
pnpm db:migrate:prod
```

这条命令把 `drizzle/migrations/` 下所有 SQL 应用到远端 D1 库。
**必须在 Worker secrets 配好之后再跑** —— 远端 D1 的状态独立于
本地的 `.wrangler/state/`。

每次 `lib/db/schema.ts` 改动并生成新迁移之后,部署前都要再跑
一次这条命令。

## 4. 种入生产管理员

```bash
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='<生产用的强密码>' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed-prod.sql

wrangler d1 execute prisim-r2-db --remote --file=/tmp/seed-prod.sql
```

注意是 `--remote`,不是 `--local`。脚本要求密码 ≥ 12 字符,但不
做熵值校验 —— 生产环境请用密码管理器生成的随机串。

种完之后立刻把 `/tmp/seed-prod.sql` 删掉,里面是 INSERT
带哈希,虽然不是明文但没必要留。

## 5. 部署

secrets、binding、远端迁移都齐了之后,从本地工作目录:

```bash
pnpm deploy
```

它会先跑 `opennextjs-cloudflare build` (把 Next.js 产物打成
`.open-next/` 下的 Workers bundle),再跑 `opennextjs-cloudflare
deploy` (内部就是 `wrangler deploy`)。CI 上同样跑 `pnpm deploy`
即可 —— 这条命令幂等,可以直接由 GitHub Actions 调用。

第一次正式发布前先做一次 dry-run 自检:

```bash
opennextjs-cloudflare build && pnpm exec wrangler deploy --dry-run
```

## 6. 应用每个 R2 桶的配置

对每一个生产环境要让 Prisim 浏览/上传的桶都做一次:

1. **CORS** —— 把 Workers 项目的 URL (例如 `https://prisim.example.com`)
   加进桶的 `AllowedOrigins`。完整规则和 `wrangler` 命令见
   [`r2-cors.zh-CN.md`](./r2-cors.zh-CN.md)。
2. **分片上传生命周期规则** —— `AbortIncompleteMultipartUpload`
   规则见 [`multipart-cleanup.zh-CN.md`](./multipart-cleanup.zh-CN.md)。
   对会上传 > 5 MB 文件的桶各应用一次。

跳过 (1) 上传会在浏览器 CORS 预检阶段静默失败,UI 拿不到有用
错误。跳过 (2) 被遗弃的分片会悄悄堆积,直到 R2 账单出问题才被察觉。

## 6. 可选:在部署上运行 E2E 套件

```bash
export E2E_BASE_URL=https://prisim.example.com
export E2E_ADMIN_EMAIL=you@example.com
export E2E_ADMIN_PASSWORD='<生产管理员密码>'
export E2E_R2_ACCOUNT_ID=<你的 32 位 R2 account id>
export E2E_R2_ACCESS_KEY=<拥有读写权限的 R2 access key>
export E2E_R2_SECRET_KEY=<对应的 secret>
export E2E_R2_BUCKET=<一个可以让脚本随意写入的一次性 R2 桶>
export E2E_NO_WEBSERVER=1   # 不要启动本地 wrangler,我们直接打生产

pnpm test:e2e
```

请使用一个 _独立于_ 真实负载的管理员账号和桶 —— 每个 spec 都会
作为执行过程的一部分创建并删除 对象/连接/分享。

如果还没装过 Playwright Chromium,先跑 `pnpm test:e2e:install`。

## 轮换 ENCRYPTION_KEY

把这个密钥视为不可变的,除非真的必须换。要换的时候:

1. 生成新密钥 (`openssl rand -base64 32`)。
2. 写一个重加密脚本:对每一条 `connections` 行,用旧密钥解密,
   再用新密钥加密 (两侧的 AAD 都还是该行的 `id` ULID)。
3. 在生产环境仍配置旧密钥的状态下应用脚本 (写一个本地工具,
   连远端 D1,逐行 UPDATE)。
4. 把 Cloudflare 上的 `ENCRYPTION_KEY` Worker secret 切换到新密钥
   (`wrangler secret put ENCRYPTION_KEY`)。
5. 重新部署 (`pnpm deploy`)。

跳过第 2 步会让每一条连接都不可读,所有 R2 调用静默失败。
除非恢复旧密钥,否则没有别的找回手段 —— 所以第 2 步开始前
务必把旧密钥也好好备份。
