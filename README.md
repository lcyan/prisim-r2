English | [中文](./README.zh-CN.md)

# Prisim R2

Web dashboard for managing one or more Cloudflare R2 buckets — browse,
upload (with multipart for large files), download via presigned URLs,
typed-confirmation deletes, and TTL-bound share links. Single-user V1;
the schema already supports multi-user and will lift the gate in V2
without migration.

## Stack at a glance

- **Framework**: Next.js 15 App Router + React 19 + TypeScript strict
- **UI**: Tailwind CSS v4 + shadcn/ui (`new-york`, stone base)
- **Data**: TanStack Query v5 (server state) + Zustand v5 (UI state)
- **DB**: Cloudflare D1 (SQLite) via Drizzle ORM
- **Auth**: Auth.js v5 Credentials provider + custom D1 adapter
- **R2 SDK**: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- **Deploy**: Cloudflare Pages (`next-on-pages`)
- **Test**: Vitest (unit) + Playwright (E2E)

See [`CLAUDE.md`](./CLAUDE.md) for the full architecture notes including
security invariants and per-request request lifecycle.

## Quick start

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then fill in the values
pnpm db:migrate:local

# Seed the single admin user
ADMIN_EMAIL=me@example.com ADMIN_PASSWORD='at-least-12-chars' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql
wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql

pnpm preview     # http://localhost:8788
```

Plain `pnpm dev` (next dev) intentionally lacks the D1 binding and will
500 on `/api/*`. Always use `pnpm preview` for full-stack work.

Step-by-step runbooks:

- **Local development** (`.dev.vars`, local D1, seed admin, `pnpm preview`,
  TOTP reset): [`docs/local-dev.md`](./docs/local-dev.md).
- **Cloudflare deployment** (Pages project setup, prod env vars, remote
  D1 migration, prod admin seed, `pnpm deploy`, `ENCRYPTION_KEY`
  rotation): [`docs/deploy-cloudflare.md`](./docs/deploy-cloudflare.md).

## Required per-bucket configuration

Before the dashboard can upload or download objects, each bucket needs:

- **CORS rule** so the browser is allowed to issue presigned `PUT` and
  `GET` requests from the dashboard origin —
  [`docs/r2-cors.md`](./docs/r2-cors.md).
- **Multipart lifecycle rule** so abandoned multipart uploads don't
  silently accumulate billable storage —
  [`docs/multipart-cleanup.md`](./docs/multipart-cleanup.md).

Both are one-time per bucket. Skipping CORS makes uploads fail at the
browser preflight with no useful error in the UI; skipping the
lifecycle rule is invisible until the R2 bill arrives.

## Tests

```bash
pnpm test                # vitest unit tests
pnpm test:coverage       # v8 coverage over lib/**
pnpm test:e2e:install    # one-time: download the Playwright Chromium
pnpm test:e2e            # full Playwright suite against `pnpm preview`
```

The E2E suite needs real R2 credentials. See
[`docs/deploy-cloudflare.md`](./docs/deploy-cloudflare.md#optional-run-the-e2e-suite-against-a-deployment)
for the required `E2E_*` env vars.
