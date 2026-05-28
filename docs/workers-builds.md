English | [中文](./workers-builds.zh-CN.md)

# Workers Builds (Git auto-deploy) runbook

Wire Prisim R2 up to Cloudflare [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
so every push to `main` (or any PR branch you opt into) auto-runs
`opennextjs-cloudflare build` + `opennextjs-cloudflare deploy` on the Cloudflare
side — no more local `pnpm deploy`.

**Prerequisite**: do one full local `pnpm deploy` per
[`deploy-cloudflare.md`](./deploy-cloudflare.md) first, so the Worker exists,
`database_id` is filled into `wrangler.toml`, the remote D1 migrations are
applied, and the production admin is seeded. Workers Builds owns the
build/deploy step **only** — it does not bootstrap the Worker for you.

## TL;DR — what to type into the "Connect to repository" dialog

> Cloudflare dashboard → **Workers & Pages** → pick `prisim-r2` → **Settings** → **Builds** → **Connect**

| Field | Value | Notes |
| --- | --- | --- |
| **Repository** | your `prisim-r2` fork on GitHub | First time, you'll need to authorize the Cloudflare GitHub App under *Git account* |
| **Production branch** | `main` | Must match the main branch in `CLAUDE.md` / `package.json` |
| **Build non-production branches** | **unchecked** (recommended) | See the "Non-production branches" section — leaving it on with the current `wrangler.toml` gives you versions you can't reach |
| **Build command** | `pnpm install --frozen-lockfile && pnpm exec opennextjs-cloudflare build` | **Do not** use `pnpm run build` / `next build` — that only runs the native Next build and produces a non-Workers bundle |
| **Deploy command** | `pnpm exec opennextjs-cloudflare deploy` | **Do not** use the default `npx wrangler deploy` — OpenNext output (`.open-next/worker.js`) needs OpenNext's deploy wrapper |
| **Non-production branch deploy command** | (under Advanced) see below | The default `npx wrangler versions upload` also won't work as-is |
| **Root directory** | leave blank | Repo root is the Next.js project; no monorepo |
| **API token** | leave blank, use auto-generated | For a minimum-permission custom token, see "Custom API token" below |
| **Build variables** | see "Build variables" section | At minimum, `NEXT_PUBLIC_APP_URL` |
| **Build cache** | leave on | Caches `node_modules` and `.next/cache`, ~50% faster |

Once you save, Cloudflare immediately triggers a build against the current
HEAD of the production branch. Live logs show up under **Worker →
Deployments**.

## 1. Why the dashboard defaults are wrong here

Cloudflare's defaults:

```
Build command:  pnpm run build              # = next build
Deploy command: npx wrangler deploy
```

For a vanilla Next.js project these work. For this repo (`@opennextjs/cloudflare`)
they fail because:

1. `next build` produces `.next/`, not the `.open-next/worker.js` wrangler expects.
2. `wrangler.toml` declares `main = ".open-next/worker.js"`, which doesn't
   exist → wrangler bails with `[ERROR] Missing entry-point`.
3. Even if you papered over that, OpenNext also has to convert Next routes
   into a Workers fetch handler, copy static assets into `[assets]`, and
   apply the cache overrides from `open-next.config.ts`. All of that is
   `opennextjs-cloudflare build`'s job, not `next build`'s.

That's why the two commands in the TL;DR table are required.

## 2. Worker name must match

Workers Builds enforces ([docs](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement)):

> The name in your Wrangler configuration file (`<Worker name>`) must match the name of your Worker.

This repo's `wrangler.toml`:

```toml
name = "prisim-r2"
```

So the Worker you **Connect** in the dashboard also has to be named
`prisim-r2`. If you already did one local `pnpm deploy`, the Worker exists
with that name — just go into its *Settings → Builds → Connect*.

If the names diverge, the build refuses itself:

```
✘ [ERROR] The name in your Wrangler configuration file (prisim-r2)
  must match the name of your Worker. Please update the name field
  in your Wrangler configuration file.
```

Fix: change `name` in `wrangler.toml` to match the dashboard, or delete the
Worker and re-create it.

## 3. Build variables vs runtime secrets are two different things

Cloudflare splits env vars into two completely separate buckets. Mixing
them gives you either "works locally, CI build dies missing
`process.env.X`" or "build passes, runtime crashes on undefined."

### 3.1 Build variables (dialog → Advanced → Build variables)

Visible **only during `opennextjs-cloudflare build`**, not at runtime. Put
only Next.js build-time inlining here:

| Name | Value | Why here |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | `https://prisim.example.com` | `next build` literal-inlines every `NEXT_PUBLIC_*` into the JS bundle ([OpenNext docs](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds)); the runtime can't read it, so it must be present at build time |
| `NODE_VERSION` _(optional)_ | `22` | Workers Builds defaults to Node 22.16.0; pinning the major guards against future drift |
| `SKIP_ENV_VALIDATION` _(optional)_ | `1` | If you ever add runtime env validation (t3-env etc.), it'll fail at build time without D1 bindings — this flag is the standard escape hatch |

> Do **not** put `AUTH_SECRET` / `ENCRYPTION_KEY` here. The build doesn't need
> them, and this surface is broader than Worker secrets (the build image
> sees them).

### 3.2 Runtime secrets (Worker → Settings → Variables and Secrets)

Same 4 values as the `wrangler secret put ...` block in
[`deploy-cloudflare.md` § 2](./deploy-cloudflare.md#2-set-production-secrets) —
that CLI is just the local equivalent of typing them into this panel.
Existing secrets are not overwritten by Workers Builds.

```
AUTH_SECRET           # 48-byte base64
AUTH_URL              # https://your-custom-domain
ENCRYPTION_KEY        # 32-byte base64
NEXT_PUBLIC_APP_URL   # same as AUTH_URL (and ALSO in Build variables above)
```

The D1 binding (`DB`) is hard-coded in `wrangler.toml` with `database_id`
filled in — nothing to do in the dashboard for D1.

## 4. The non-production-branches trap

`wrangler.toml` has these two **off**:

```toml
workers_dev = false
preview_urls = false
```

Which means:

- Even if Workers Builds produces a *version* for your feature branch,
  there's no `*.workers.dev` subdomain and no per-version preview URL that
  routes to it → previews are useless.
- The default "Non-production branch deploy command"
  `npx wrangler versions upload` succeeds under this config but the version
  it uploads is never reachable via a URL.

**So leave "Build non-production branches" unchecked by default** — let
Cloudflare build+deploy only on pushes to `main`.

If you actually want PR previews:

1. Set `preview_urls = true` in `wrangler.toml` (commit it).
2. Re-run `pnpm deploy` once locally so the setting is applied.
3. Set the "Non-production branch deploy command" to
   `pnpm exec opennextjs-cloudflare upload` (which calls
   `wrangler versions upload`). Cloudflare then gives you a
   `https://<version-id>-prisim-r2.<account>.workers.dev` preview URL.

Note: preview URLs are public — they share **production D1** with main.
Anyone with the URL can log into your production admin UI. Keep this off
unless you need it.

## 5. API token

Leave blank — Cloudflare auto-generates a Workers-Builds-only token for
the account with enough permission to deploy any Worker, manage D1
migrations, and write secrets.

If your security policy requires a least-privilege custom token, build one
per the [Cloudflare docs](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)
with:

- *Workers Scripts*: Edit
- *D1*: Edit (only if you plan to run `db:migrate:prod` from CI)
- *Account Settings*: Read (account ID lookup)
- *User Details*: Read

Then paste it into the "API token" field.

## 6. CI does NOT run D1 migrations for you

`opennextjs-cloudflare deploy` deploys the Worker code only — it does
**not** run `wrangler d1 migrations apply`. If a single push includes both
a schema change and code that depends on it, the deployed code will expect
the new tables while remote D1 still has the old schema → 500 on the first
request.

Two options (pick one):

1. **Migrate first, push second**: locally `pnpm db:migrate:prod`, verify,
   then `git push`. Code lands after schema does.
2. **Migrate in CI**: append to the build command:

   ```
   pnpm install --frozen-lockfile \
     && pnpm exec wrangler d1 migrations apply DB --remote \
     && pnpm exec opennextjs-cloudflare build
   ```

   This requires the API token to have *D1: Edit* — the auto-generated
   token does; a custom one needs that permission added.

Option #1 is recommended (releases that pair schema + code have always
been a manual step anyway).

## 7. Build image defaults

Workers Builds uses the [build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
defaults:

| Tool | Default | This repo needs | Override? |
| --- | --- | --- | --- |
| Node.js | 22.16.0 | ≥ 18 (Next 15 + Workers Assets) | no |
| pnpm | inferred from `package.json` `packageManager: "pnpm@11.2.2"` | 11.x | no — corepack honors `packageManager` |
| wrangler | from `package.json` devDependencies (`^4.93.0` here) | ≥ 4.13 (`keep_names` config requires it) | no |

Only set `NODE_VERSION` as a build variable if you want to pin the major.

## 8. After the first build

1. **Connect**, fill the dialog per the TL;DR.
2. The first auto-build runs immediately; a deployment tagged *via Workers CI*
   shows up under Deployments.
3. Browse the custom domain → walk through `/login` → check the audit log
   (`wrangler d1 execute prisim-r2-db --remote --command "SELECT operation,
   target, user_id, created_at FROM audit_log ORDER BY created_at DESC
   LIMIT 10"`) to confirm the deploy didn't wipe existing D1 data.
4. From now on `git push origin main` → Cloudflare auto-builds + deploys.
   Still recommend running `pnpm typecheck && pnpm lint && pnpm test`
   locally before pushing — Workers Builds won't run those for you, and a
   build failure only surfaces after the push.

## 9. Rolling back

Workers Builds keeps a Deployments history. If a build is broken or the
new version misbehaves in prod, go to *Worker → Deployments*, find the
previous *Active* version, click **Rollback**.

Code-side, `git revert <bad-sha> && git push origin main` also works —
Cloudflare will pick up the revert commit and ship it through the normal
build path. Either is fine.
