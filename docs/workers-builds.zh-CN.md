[English](./workers-builds.md) | 中文

# Workers Builds (Git 自动部署) Runbook

把 Prisim R2 接到 Cloudflare 的 [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)，
让每次推到 `main` (或任意打开 PR 的分支) 都在 Cloudflare 侧自动跑
`opennextjs-cloudflare build` + `opennextjs-cloudflare deploy`，免去本地 `pnpm deploy`。

**前置**：先按 [`deploy-cloudflare.zh-CN.md`](./deploy-cloudflare.zh-CN.md) 跑过一次本地 `pnpm deploy`，
确保 Worker 已经创建、`wrangler.toml` 里 `database_id` 填好、生产 D1 迁移已应用、生产
admin 已 seed。Workers Builds 只接管 build/deploy 流程，**不接管首次 provisioning**。

## TL;DR — 截图里那张对话框该填什么

> Cloudflare 控制台 → **Workers & Pages** → 选中 `prisim-r2` → **Settings** → **Builds** → **Connect**

| 字段 | 填什么 | 备注 |
| --- | --- | --- |
| **存储库** | 选你 fork / push 的 `prisim-r2` GitHub 仓库 | 第一次连要先在 *Git account* 里授权 Cloudflare GitHub App |
| **生产分支** | `main` | 必须和 `CLAUDE.md` / `package.json` 里的主分支保持一致 |
| **非生产分支构建** | **取消勾选**（推荐） | 见下方「非生产分支」一节 — 默认开会拿不到可访问的 URL |
| **构建命令** | `pnpm install --frozen-lockfile && pnpm exec opennextjs-cloudflare build` | **不要**写 `pnpm run build` / `next build` — 那只跑 Next 原生 build，产出的不是 Workers bundle |
| **部署命令** | `pnpm exec opennextjs-cloudflare deploy` | **不要**用默认的 `npx wrangler deploy` — OpenNext 产物 `.open-next/worker.js` 需要走 OpenNext 自己的 deploy wrapper |
| **非生产分支部署命令** | （高级设置里）见下 | 默认 `npx wrangler versions upload` 也不能直接用 |
| **根目录** | 留空 | 仓库根就是 Next.js 工程，没有 monorepo |
| **API 令牌** | 留空，用自动生成的 | 想换成最小权限自建 token 见下「自建 API token」 |
| **构建变量** | 见「构建变量」一节 | 至少要塞 `NEXT_PUBLIC_APP_URL` |
| **构建缓存** | 默认开启 | 命中 `node_modules`、`.next/cache`，加速 ~50% |

存好之后，Cloudflare 会立即基于 `生产分支` 当前 HEAD 触发一次构建。在
**Worker → Deployments** 标签下能看到实时日志。

## 一、为什么默认的命令不对

Cloudflare 控制台默认值：

```
构建命令: pnpm run build              # = next build
部署命令: npx wrangler deploy
```

对一个 plain Next.js 项目这能跑；对本仓库（`@opennextjs/cloudflare`）会失败，因为：

1. `next build` 产物是 `.next/`，不是 `wrangler` 需要的 `.open-next/worker.js`。
2. `wrangler.toml` 里 `main = ".open-next/worker.js"`，路径不存在 → wrangler 直接 `[ERROR] Missing entry-point`。
3. 即便绕过去，OpenNext 还要把 Next 路由 → Workers fetch handler 的转换、静态资源
   → `[assets]` 的搬运、`open-next.config.ts` 里的 cache overrides 跑一遍，这些都是
   `opennextjs-cloudflare build` 干的活，不是 `next build`。

所以必须改成上面 TL;DR 表格里的两条命令。

## 二、Worker 名字必须匹配

Workers Builds 的硬约束 ([docs](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement))：

> The name in your Wrangler configuration file (`<Worker name>`) must match the name of your Worker.

本仓库 `wrangler.toml`：

```toml
name = "prisim-r2"
```

所以你在控制台里要 **Connect** 的那个 Worker 也必须叫 `prisim-r2`。
如果你已经手动 deploy 过一次（`pnpm deploy`），那 Cloudflare 上就已经有同名 Worker，
直接进它的 *Settings → Builds → Connect* 就好。

如果两边名字不一致，构建会被它自己拒绝：

```
✘ [ERROR] The name in your Wrangler configuration file (prisim-r2)
  must match the name of your Worker. Please update the name field
  in your Wrangler configuration file.
```

修法：要么改 `wrangler.toml` 的 `name` 去匹配控制台上的 Worker，要么删了 Worker 重建。

## 三、构建变量和运行时变量是两套

Cloudflare 把变量分成两个完全独立的桶，搞错了会出现「本地能跑，CI build 起来缺
`process.env.X`」或者「build 过了，运行时报 undefined」。

### 3.1 构建变量（在「连接到仓库」对话框 → 高级设置 → 构建变量）

只在 `opennextjs-cloudflare build` 期间存在，**runtime 拿不到**。这里只放 Next.js
build 期间要内联进 bundle 的东西：

| 名字 | 值 | 为什么放这里 |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | `https://prisim.example.com` | `next build` 会把所有 `NEXT_PUBLIC_*` 字面内联进 JS bundle ([OpenNext 说明](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds))；runtime 拿不到这个，所以必须在 build 阶段就给到 |
| `NODE_VERSION` _(可选)_ | `22` | Workers Builds 默认 Node 22.16.0；显式锁版本能避免日后默认值漂移 |
| `SKIP_ENV_VALIDATION` _(可选)_ | `1` | 如果以后接入 t3-env 一类的运行时校验，build 阶段缺 D1 binding 会抛错，用这个跳过 |

> 不要把 `AUTH_SECRET` / `ENCRYPTION_KEY` 放在「构建变量」里 —— build 不需要它们，
> 而且这里会写进 build 镜像，比 Worker secrets 多一层暴露面。

### 3.2 运行时 secrets（Worker → Settings → Variables and Secrets）

跟 [`deploy-cloudflare.zh-CN.md` § 2](./deploy-cloudflare.zh-CN.md#2-配置生产-secrets) 里
说的 `wrangler secret put ...` 是同一批东西，本地命令的等价物。可以继续用 `wrangler
secret put` 在本地配，也可以直接在控制台的 *Variables and Secrets* 面板里加。已经
配好的 secret 不会被 Workers Builds 覆盖。

需要的 4 条 secret：

```
AUTH_SECRET           # 48 字节 base64
AUTH_URL              # https://你的自定义域名
ENCRYPTION_KEY        # 32 字节 base64
NEXT_PUBLIC_APP_URL   # 同 AUTH_URL（也要在「构建变量」里放一份）
```

D1 binding (`DB`) 已经在 `wrangler.toml` 里写死了 `database_id`，每次 deploy 自动
应用，不用在控制台里手动配。

## 四、非生产分支（feature / PR 分支）的坑

`wrangler.toml` 里两项是 **关闭** 的：

```toml
workers_dev = false
preview_urls = false
```

意味着：

- 即便 Workers Builds 给非生产分支构建出了一个 *version*，也没有任何
  `*.workers.dev` 子域 / per-version 预览 URL 能访问它 → preview 没意义。
- 默认的「非生产分支部署命令」`npx wrangler versions upload` 在这个配置下虽然
  会成功，但产出的 version 永远不会被任何 URL 路由到。

**所以默认要把「非生产分支构建」这个 checkbox 取消勾选** —— 让 Cloudflare 只对推到
`main` 的 commit 跑构建+部署。

如果你确实想要 PR preview：

1. 把 `wrangler.toml` 改成 `preview_urls = true`（重新 commit）；
2. 重新跑一次 `pnpm cf-typegen` 不需要，但要重新 `pnpm deploy` 一次让设置生效；
3. 在「非生产分支部署命令」里填 `pnpm exec opennextjs-cloudflare upload`
   （会调用 `wrangler versions upload`），构建完成后 Cloudflare 会给一个
   `https://<version-id>-prisim-r2.<account>.workers.dev` 的预览 URL。

注意 preview URL 是公网可达的 —— 上面跑的是 **production D1**，所以任何能拿到
preview URL 的人都能登录你的生产管理界面。除非你有需求，建议保持关闭。

## 五、API 令牌

留空即可 —— Cloudflare 会自动给你 account 生成一个仅供 Workers Builds 用的
token，权限是「能 deploy 任何 Worker + 写 D1 migrations + 写 secrets」。

如果你的合规策略要求自建最小权限 token，按 [Cloudflare 文档](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)
建一个带下面权限的 API token，再在「API 令牌」字段里粘进去：

- *Workers Scripts*: Edit
- *D1*: Edit（如果以后想在 CI 跑 `db:migrate:prod`）
- *Account Settings*: Read（用来读 account ID）
- *User Details*: Read

## 六、CI 不会自动跑 D1 迁移

`opennextjs-cloudflare deploy` 只 deploy Worker 代码，**不会** 跑
`wrangler d1 migrations apply`。如果一次推送同时改了 schema 又改了代码，CI 部署的
代码会期望新表，但远端 D1 还是老 schema → 第一个请求就 500。

两种解法（选一）：

1. **先迁移、再 push 代码**：本地先 `pnpm db:migrate:prod`，确认无误，再
   `git push`。代码部署完之后两边 schema 才一致。
2. **CI 里加一步迁移**：在「构建命令」尾部串上：

   ```
   pnpm install --frozen-lockfile \
     && pnpm exec wrangler d1 migrations apply DB --remote \
     && pnpm exec opennextjs-cloudflare build
   ```

   注意这要求自动 API token 有 D1 Edit 权限 —— 默认生成的 token 是有的，但自建
   token 就需要手动勾上。

推荐 #1（迁移和代码同步发布的发布事务一直就是手工动作）。

## 七、Build 镜像默认值

Workers Builds 用 Cloudflare 的 [build 镜像](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
默认值：

| 工具 | 默认版本 | 本仓库要求 | 是否需要覆盖 |
| --- | --- | --- | --- |
| Node.js | 22.16.0 | ≥ 18（next 15 + Workers Assets） | 否 |
| pnpm | 由 `package.json` 的 `packageManager: "pnpm@11.2.2"` 自动检测 | 11.x | 否（corepack 走 `packageManager`） |
| wrangler | 由 `package.json` `devDependencies` 决定（本仓库 `^4.93.0`） | ≥ 4.13（`keep_names` 配置项要求） | 否 |

只有要锁 Node major 版本时才设 `NODE_VERSION` 构建变量。

## 八、推上去之后

1. **Connect**，对话框各字段按上面 TL;DR 填好；
2. 第一次自动构建跑完，Deployments 里会出现 *via Workers CI* 标记的版本；
3. 浏览自定义域名 → 走过 `/login` → 看 audit log（`wrangler d1 execute prisim-r2-db
   --remote --command "SELECT operation, target, user_id, created_at FROM audit_log
   ORDER BY created_at DESC LIMIT 10"`）确认 deploy 没把已有 D1 数据吹掉；
4. 之后每次 `git push origin main` → Cloudflare 自动 build + deploy，不再需要本地
   `pnpm deploy`。仍然鼓励本地跑一次 `pnpm typecheck && pnpm lint && pnpm test`
   再 push —— Workers Builds 不会替你跑测试，build 失败要等 push 之后才知道。

## 九、回滚

Workers Builds 自动留 *Deployments* 历史。任何一次跑挂的、或新版本在生产爆雷，
进 *Worker → Deployments* 找到上一个 *Active* 版本，点 **Rollback** 即可。

代码层面也可以 `git revert <bad-sha> && git push origin main` —— Cloudflare 会
按正常流程把 revert 之后的 commit 重新部署。两条路都通。
