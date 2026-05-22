# Deployment runbook

Step-by-step for taking Prisim R2 from a clean clone to a live
Cloudflare Pages deployment.

## 0. Prerequisites

- `pnpm` (Node 22 LTS or newer).
- `wrangler` authenticated to your Cloudflare account
  (`wrangler login` once per workstation).
- A Cloudflare R2 access token with R2 read+write scope for at least
  one bucket. Prisim never creates buckets — pick one you already own
  or create one in the dashboard first.
- A throwaway R2 bucket if you plan to run the E2E suite.

## 1. Install + generate the encryption key

```bash
pnpm install
pnpm test:e2e:install     # one-time: downloads Chromium for Playwright

# 32-byte master key for AES-GCM credential encryption.
# Treat this like a database password. Losing it makes every existing
# connections row unreadable; rotating it requires re-encrypting every
# connections row (see CLAUDE.md "Rotating ENCRYPTION_KEY").
openssl rand -base64 32
```

Copy the printed value. Stash it in your password manager — you'll
need it for `.dev.vars` (local) and Cloudflare Pages env vars (prod).

## 2. Set up local environment variables

Create `.dev.vars` in the repo root (gitignored):

```bash
AUTH_SECRET=$(openssl rand -base64 48)
AUTH_URL=http://localhost:8788
ENCRYPTION_KEY=<the base64 you generated above>
NEXT_PUBLIC_APP_URL=http://localhost:8788
```

`AUTH_SECRET` and `ENCRYPTION_KEY` are NOT the same thing. `AUTH_SECRET`
signs the Auth.js JWT; `ENCRYPTION_KEY` envelopes R2 access keys at rest.
A leaked `AUTH_SECRET` lets an attacker forge sessions; a leaked
`ENCRYPTION_KEY` exposes every stored R2 credential. Treat both as
production-grade secrets.

## 3. Create the D1 database (first time only)

```bash
wrangler d1 create prisim-r2-db
```

Copy the returned `database_id` UUID into `wrangler.toml`, replacing
the `00000000-...` placeholder.

## 4. Apply migrations

```bash
pnpm db:migrate:local
```

This runs every SQL file under `drizzle/migrations/` against the local
D1 emulator (`.wrangler/state/v3/d1/`). The same command with
`pnpm db:migrate:prod` applies them to the remote D1 — do that AFTER
production env vars are set (step 7), never before.

## 5. Seed the admin user

Prisim has no signup UI. The admin row is provisioned via a script:

```bash
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='at-least-12-chars' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql

wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql
```

The script prints the INSERT statement to stdout so you can audit the
hash before applying it. For production, re-run with `--remote` and
choose a stronger password — the script enforces ≥ 12 chars but doesn't
gate on entropy.

## 6. Smoke-test locally

```bash
pnpm preview
```

This runs `next-on-pages` (the Cloudflare Pages build) and then
`wrangler pages dev` on port 8788. Open http://localhost:8788, sign in
with the credentials from step 5. The dashboard should redirect to the
empty connections page; add a connection with your throwaway R2
credentials to verify the full encrypt → decrypt → R2 probe flow.

> **NOTE:** `pnpm dev` (plain `next dev`) does NOT bind D1 — anything
> that hits `/api/*` returns 500. Always use `pnpm preview` when you
> want to exercise the API.

## 7. Configure the Cloudflare Pages project

In the Cloudflare dashboard → Workers & Pages → Create application →
Connect a Git repository → Build configuration:

- Build command: `pnpm install --frozen-lockfile && pnpm build:pages`
- Build output: `.vercel/output/static`
- Node version: 22
- Environment variables (set under both Production and Preview):
  - `AUTH_SECRET`
  - `AUTH_URL` (the Pages URL, e.g. `https://prisim.example.com`)
  - `ENCRYPTION_KEY`
  - `NEXT_PUBLIC_APP_URL` (same as AUTH_URL)
- Bindings → D1 database: bind `DB` to the database created in step 3.

`NEXT_PUBLIC_*` is read at build time, not runtime, so a value change
requires a new deploy.

## 8. Apply remote migrations + seed the prod admin

```bash
pnpm db:migrate:prod
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='<strong production password>' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed-prod.sql
wrangler d1 execute prisim-r2-db --remote --file=/tmp/seed-prod.sql
```

## 9. Deploy

From your local checkout once env + bindings are set:

```bash
pnpm deploy
```

This runs `next-on-pages` then `wrangler pages deploy`. CI deploys
should run the same two commands (the `deploy` script is intentionally
minimal so it's safe to invoke from GitHub Actions).

Sanity-check with a dry run before the first real push:

```bash
pnpm exec wrangler pages deploy --dry-run
```

## 10. Apply R2 bucket configuration

For each bucket the admin will browse via Prisim:

1. CORS — `docs/r2-cors.md` for the recommended JSON. Apply once per
   bucket the dashboard origin should be allowed to upload/download to.
2. Multipart lifecycle — `docs/multipart-cleanup.md` for the
   `AbortIncompleteMultipartUpload` rule. Apply once per bucket users
   will upload > 5 MB files to.

Without (1), uploads fail at the browser CORS layer with no useful
error in the UI. Without (2), abandoned multipart parts accumulate
silently and inflate the bill.

## 11. Optional: run the E2E suite against this deployment

```bash
export E2E_BASE_URL=https://prisim.example.com
export E2E_ADMIN_EMAIL=you@example.com
export E2E_ADMIN_PASSWORD='<the production admin password>'
export E2E_R2_ACCOUNT_ID=<your 32-char R2 account id>
export E2E_R2_ACCESS_KEY=<R2 access key with read/write>
export E2E_R2_SECRET_KEY=<matching secret>
export E2E_R2_BUCKET=<a throwaway R2 bucket the spec can litter in>
export E2E_NO_WEBSERVER=1   # skip starting a local wrangler; we're hitting prod

pnpm test:e2e
```

Use a _separate_ admin user and bucket from your real workload — every
spec creates and deletes objects/connections/shares as part of running.

## Rotating ENCRYPTION_KEY

Treat the key as immutable until you absolutely must rotate it. When
you do:

1. Generate a new key.
2. Write a re-encryption script that, for each `connections` row,
   decrypts with the old key and re-encrypts with the new one (with
   the existing `id` as AAD on both sides).
3. Apply the script while the production env still has the old key.
4. Swap the env var to the new key.
5. Redeploy.

Skipping step 2 leaves every connection unreadable and silently breaks
every R2 call. There is no recovery path other than restoring the old
key.
