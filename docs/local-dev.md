English | [中文](./local-dev.zh-CN.md)

# Local development runbook

Step-by-step for getting Prisim R2 running on your machine. If you're
heading to a Cloudflare Workers deploy, get local working first and then
read [`deploy-cloudflare.md`](./deploy-cloudflare.md).

## 0. Prerequisites

- `pnpm` (Node 22 LTS or newer).
- `wrangler` authenticated to your Cloudflare account (`wrangler login`
  once per workstation). You need this even for local dev because
  `pnpm preview` runs the Workers emulator (via `@opennextjs/cloudflare`).
- An R2 access token with read+write scope to at least one bucket.
  Prisim never creates buckets — pick one you already own in the
  Cloudflare dashboard (or create one) and grab its access key + secret.

## 1. Install + generate the encryption key

```bash
pnpm install

# 32-byte master key for AES-GCM credential encryption.
# Treat this like a database password. Losing it makes every existing
# connections row unreadable; rotating it requires re-encrypting every
# row (see CLAUDE.md "Rotating ENCRYPTION_KEY").
openssl rand -base64 32
```

Copy the printed value. Stash it in your password manager — `.dev.vars`
needs it next. **Use a different key for local and prod** so a leak in
your dev box doesn't expose production credentials.

## 2. Configure `.dev.vars`

Create `.dev.vars` in the repo root (gitignored):

```bash
AUTH_SECRET=$(openssl rand -base64 48)
AUTH_URL=http://localhost:8787
ENCRYPTION_KEY=<the base64 you generated above>
NEXT_PUBLIC_APP_URL=http://localhost:8787
```

`AUTH_SECRET` and `ENCRYPTION_KEY` are not the same thing.
`AUTH_SECRET` signs the Auth.js JWT; `ENCRYPTION_KEY` envelopes R2
access keys at rest. Treat both as production-grade secrets — even
locally, a leaked `ENCRYPTION_KEY` means every R2 credential stored in
your local D1 is exposed.

## 3. Create the local D1 database (first time only)

```bash
wrangler d1 create prisim-r2-db
```

Copy the returned `database_id` UUID into `wrangler.toml`, replacing
the `00000000-...` placeholder. This setting drives both the local and
the remote binding — there's only one `database_id` in `wrangler.toml`.

> Note: `wrangler d1 create` creates the database on the Cloudflare
> side. If a database with that name already exists on your account,
> skip `create` and paste its existing `database_id` into
> `wrangler.toml` directly.

## 4. Apply local migrations

```bash
pnpm db:migrate:local
```

This runs every SQL file under `drizzle/migrations/` against the local
D1 emulator (`.wrangler/state/v3/d1/`). Re-run this every time you
change `lib/db/schema.ts` and regenerate migrations with
`pnpm db:gen`.

## 5. Seed the admin user

Prisim has no signup UI. The admin row is provisioned via a script:

```bash
ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD='at-least-12-chars' \
  pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql

wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql
```

The script prints the INSERT statement to stdout so you can audit the
hash before applying it.

## 6. Run the local dev server

```bash
pnpm preview
```

This runs `opennextjs-cloudflare build` to produce the Workers bundle
under `.open-next/`, then serves it via `wrangler dev` on port 8787.
Open http://localhost:8787 and sign in with the credentials from step 5.
First login forces a TOTP enrollment; scan the QR and you should land
on an empty connections page. Add a connection with your R2
credentials to verify the full encrypt → decrypt → R2 probe flow.

> **Important**: `pnpm dev` (plain `next dev`) does NOT bind D1 —
> anything that hits `/api/*` returns 500. Use `pnpm preview` whenever
> you need the API. `pnpm dev` is only useful for pure UI / style work.

## 7. (Optional) R2 CORS for local uploads against a real bucket

If you want to upload/download against a real R2 bucket from
`http://localhost:8787`, add that origin to the bucket's CORS
`AllowedOrigins`. Full rules and the `wrangler` command live in
[`r2-cors.md`](./r2-cors.md).

Skip this if you're only running Vitest unit tests or clicking through
UI without triggering real uploads.

## 8. Run tests

```bash
pnpm test                # Vitest unit tests
pnpm test:watch          # watch mode
pnpm test:coverage       # v8 coverage over lib/**
```

The Playwright E2E suite is optional. First run needs the browser
binaries:

```bash
pnpm test:e2e:install    # one-time: downloads Chromium for Playwright
pnpm test:e2e            # runs against `pnpm preview` by default
```

E2E needs real R2 credentials. See the optional E2E section in
[`deploy-cloudflare.md`](./deploy-cloudflare.md#optional-run-the-e2e-suite-against-a-deployment)
for the full list of `E2E_*` environment variables.

## TOTP reset (forgotten authenticator / test scenarios)

Forced TOTP is part of the login flow. If you want to clear TOTP
state locally and re-walk the enrollment flow:

```bash
wrangler d1 execute prisim-r2-db --local --command \
  "UPDATE users SET totp_enabled = 0, totp_secret_ciphertext = NULL, totp_secret_iv = NULL, totp_confirmed_at = NULL"
wrangler d1 execute prisim-r2-db --local --command \
  "DELETE FROM recovery_codes"
wrangler d1 execute prisim-r2-db --local --command \
  "DELETE FROM totp_replay_guard"
```

Next login re-enters `/setup/totp`. Do **not** do raw SQL like this in
production — use the recovery-code flow or re-seed the admin row
instead.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Login 500 with `D1_ERROR: no such table` | You skipped `pnpm db:migrate:local`, or `wrangler.toml`'s `database_id` is still the placeholder |
| Login page loads but `/api/csrf` 500s | You're running `pnpm dev` instead of `pnpm preview` |
| Upload fails instantly, no PUT in DevTools network | Bucket CORS doesn't include `http://localhost:8787` — see step 7 |
| `crypto.*` error when adding a connection | `.dev.vars`'s `ENCRYPTION_KEY` isn't valid base64 or is shorter than 32 bytes |
