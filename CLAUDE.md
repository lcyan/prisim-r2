# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Web app for managing Cloudflare R2 buckets (browse / upload / download / delete / share). **Single-user V1** (one admin seeded via `scripts/seed-admin.ts`); the "user owns multiple R2 connections" model is already in the schema (V2 will lift the single-user constraint without migration).

## Stack

- **Framework**: Next.js 15 App Router + React 19 + TypeScript strict (`noUncheckedIndexedAccess`, `noImplicitOverride`)
- **UI**: Tailwind CSS v4 (`@theme` in `app/globals.css`, no `tailwind.config.js`) + shadcn/ui (`new-york` style, stone base, copied into `components/ui/`)
- **Data**: TanStack Query v5 (server state) + Zustand v5 (UI state only)
- **DB**: Cloudflare D1 (SQLite) via Drizzle ORM. Schema in `lib/db/schema.ts`; migrations in `drizzle/migrations/`
- **Auth**: Auth.js v5 (next-auth `5.0.0-beta.31`) Credentials provider + custom D1 adapter (`lib/auth/adapter.ts`)
- **R2 SDK**: pinned `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2 = S3-compatible)
- **Deploy**: Cloudflare Pages (`next-on-pages`) — every `/api/*` route is edge runtime
- **Test**: Vitest for unit/integration. Playwright is supported for E2E — install (`pnpm dlx playwright install`) and add a `playwright.config.ts` before invoking it; tests go under `tests/e2e/`. Don't add an E2E "for completeness" — it only makes sense when a behavior can't be covered by Vitest (real browser download manager, multipart upload retry across reload, etc.).

## Commands

```bash
# Local dev
pnpm preview          # next-on-pages && wrangler pages dev → :8788 (REQUIRED for full app)
pnpm dev              # next dev → :3000 (UI-only; D1 binding missing → /login returns 500)

# Build / deploy
pnpm build            # next build (typecheck via next + tsc)
pnpm build:pages      # next-on-pages (writes .vercel/output/)
pnpm deploy           # next-on-pages && wrangler pages deploy

# Quality
pnpm typecheck        # tsc --noEmit (strict)
pnpm lint / lint:fix  # eslint . (flat config; ignores .next .vercel .wrangler components/ui)
pnpm format / format:check  # prettier

# Tests (Vitest unit only)
pnpm test                                  # vitest run
pnpm test:watch
pnpm test:coverage                         # v8 coverage over lib/**/*.ts
pnpm test tests/unit/r2/presign.test.ts    # single file
pnpm test -t "rejects empty bucket"        # single test name

# DB (Drizzle + Wrangler D1)
pnpm db:gen           # after editing lib/db/schema.ts — generates drizzle/migrations/NNNN_*.sql
pnpm db:migrate:local # wrangler d1 migrations apply DB --local (writes .wrangler/state/v3/d1/)
pnpm db:migrate:prod  # wrangler d1 migrations apply DB --remote
```

**Local-dev gotcha**: `next dev` silently lacks the Cloudflare bindings (`getRequestContext().env.DB` is undefined), so anything touching D1 (login, /api/\*) 500s. Use `pnpm preview` for any work that hits the server.

**Seeding the admin user** (no signup UI):

```bash
ADMIN_EMAIL=me@x.com ADMIN_PASSWORD='at-least-12-chars' pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql
wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql
```

**重置 TOTP**（用于本地测试 / 忘记 Authenticator）:

```bash
wrangler d1 execute prisim-r2-db --local --command "UPDATE users SET totp_enabled = 0, totp_secret_ciphertext = NULL, totp_secret_iv = NULL, totp_confirmed_at = NULL"
wrangler d1 execute prisim-r2-db --local --command "DELETE FROM recovery_codes"
wrangler d1 execute prisim-r2-db --local --command "DELETE FROM totp_replay_guard"
```

下次登录将再次走 `/setup/totp` 重新绑定。

## Security Invariants (non-negotiable)

These rules override any other suggestion. If a request conflicts with them, push back.

1. **Credentials are AES-GCM encrypted at rest.** R2 access keys / secrets are encrypted with AES-GCM-256 via Web Crypto (`crypto.subtle`) using the server-only `ENCRYPTION_KEY` env. AAD MUST be the `connections.id` ULID so a ciphertext copied between rows fails the GCM tag check. See `lib/crypto/aes-gcm.ts`. Never write plaintext credentials to DB, logs, error messages, or telemetry.
2. **Credentials never reach the browser.** API responses NEVER include decrypted secrets. List endpoints return `ConnectionSummary` (see `lib/api/types.ts`) with `accessKeyMasked` only (`AKIA****WXYZ` via `maskAccessKey`). Decryption happens in the route handler, in memory, for one R2 call. The `GET /api/connections` select column list is explicit (no `select(*)`) so adding a future secret column cannot leak it.
3. **All object I/O goes through presigned URLs.** Uploads, downloads, and multipart parts are direct browser ↔ R2 via presigned URL (`PUT` / `GET` / `UploadPart`). The Next.js server NEVER proxies object bytes — `lib/r2/presign.ts` mints URLs, `lib/r2/control.ts` does control-plane calls (list/delete/multipart bookkeeping) only. Presigned URLs are not persisted or logged.<br>**Exception:** control-plane R2 calls (list, delete, create/complete/abort multipart upload) MAY be made server-side as they only exchange metadata, not object bytes.
4. **Destructive ops require explicit confirmation.** Delete bucket, empty prefix, bulk delete, connection delete with active shares, and credential rotation MUST require a typed confirmation on the client AND a confirmation token validated server-side (error code `confirmation.required`).
5. **CSRF on every mutating route.** Sessions carry a `csrf_token_hash` in D1. `withApi` enforces `X-CSRF-Token` header == sha256-matched to D1 row for all POST/PATCH/PUT/DELETE. Revoking a session (deleting the D1 row) also revokes CSRF authority. Never bypass `requireCsrf` for "convenience".

## Architecture

### Request lifecycle for `/api/*`

Every API handler is wrapped by `withApi` (`lib/api/middleware.ts`):

```
withApi(handler, options)
 → requestId = crypto.randomUUID()
 → requireSession      (JWT decode + D1 sessions row check → SessionContext)
 → requireCsrf         (POST/PATCH/PUT/DELETE only)
 → rateLimit(policies) (opt-in; D1 sliding-window UPSERT)
 → handler(req, ctx)   (ctx has userId, email, sessionToken, csrfTokenHash, requestId)
 → catch → toErrorResponse → unified { error: { code, message, requestId, details? } }
```

Handlers return either raw JSON-serializable values (auto-wrapped in `Response.json`) or a hand-built `Response` (e.g. 201 with `Location`). Throw `ApiError` (factories in `ApiErrors`) or `ZodError` for typed failures.

### Two auth configs (do NOT merge)

- `lib/auth/config.ts` — **edge middleware** config. No adapter, no D1, no callbacks beyond `authorized`. `middleware.ts` imports this because Next.js edge middleware runs without `getRequestContext()`.
- `lib/auth/index.ts` — **full** Auth.js instance for route handlers and server actions. Adds Credentials provider, jwt/session/signOut callbacks, and the D1 adapter. Revocation enforcement (delete D1 session row → next `auth()` returns null) lives here in the `session()` callback.

Sessions use JWT strategy (Credentials forces it) but are DB-backed: on sign-in the `jwt()` callback mints a ULID session token + raw CSRF token, persists sha256 of both in `sessions`, embeds raw tokens in the JWT. CSRF cookie is set by `GET /api/csrf` (not httpOnly — client JS must read it for `X-CSRF-Token`).

### Per-request R2 client (no caching)

`lib/r2/client.ts` builds a fresh `S3Client` per request (`region: "auto"`, `endpoint: https://<accountId>.r2.cloudflarestorage.com`, `forcePathStyle: true`). No caching — multi-tenant isolation requires that keys don't outlive one call. Routes split work:

- `lib/r2/presign.ts` — `presignPut` / `presignGet` / `presignUploadPart`. Mints URLs only; no SDK round-trip from our worker.
- `lib/r2/control.ts` — `listBuckets`, `listObjects`, `deleteObjects` (chunks at 1000), `createMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload`. Errors normalized via `mapR2Error` into `R2CredentialError` (→ route layer 401) vs `R2UpstreamError` (→ 5xx).

### Validation, types, and the server-only boundary

- `lib/api/schemas.ts` — every API input schema (Zod). Naming: `<Domain><Verb>Schema` + matching `<...>Input` via `z.infer`. `parseJson(req, Schema)` rejects non-JSON with a clear ZodError. Constants like `R2_PRESIGN_DEFAULT_TTL_SECONDS` and `R2_PRESIGN_MAX_TTL_SECONDS` live here so route and docs cannot drift.
- `lib/api/types.ts` — public response shapes (`ConnectionSummary`, …). Browser code (hooks, components) MUST import from here, not from `app/api/*` route modules — those have `import "server-only"`.
- `lib/api/errors.ts` — `ApiErrorCode` enum + `ApiErrors.*` factories + `toErrorResponse`. Add a new code here before throwing it. Never inline a raw string at a callsite.
- `lib/api/client.ts` — browser `apiFetch` wrapper. Reads the CSRF cookie, injects `X-CSRF-Token`, parses `{ error: { code, … } }` into a typed `ApiClientError`. All TanStack Query mutations go through this.

### Rate limiting

`lib/api/rate-limit.ts` is a D1-backed sliding-window limiter. Single atomic UPSERT into `rate_limit_buckets`. Use `RateLimitBundles.*(userId)` from route options — order is narrowest-first so the user gets the most actionable `policy` in the 429 error. Current caps (PRD §6): login 10/5min/IP, presign 60/min/user, share-create 30/min/user, write-aggregate 600/min/user.

### Audit log

`lib/audit/log.ts` writes to `audit_log` table. **`AuditOp` is a closed string-literal union** — adding a new operation requires adding it to that type, which catches typos at compile time. `logAudit` is no-fail (wraps in try/catch + `console.error`) so telemetry never breaks the user-facing request. Always `await` it in route handlers so the row flushes before Pages spins down the worker.

### Hooks ↔ stores ↔ components

- `hooks/` — one TanStack Query hook per resource. Query key tuples are exported as `const` (e.g. `CONNECTIONS_QUERY_KEY`). Mutations do both optimistic patch (snappy UI) and `invalidateQueries` (close the loop if server normalized).
- `stores/` — Zustand. UI state only. NEVER store credentials, tokens, or PII.
- `components/ui/` — shadcn primitives. **Re-run the shadcn CLI to update; never hand-edit.** `components/ui` is also in `.prettierignore` to avoid noisy diffs.
- `components/features/<domain>/` — feature components (`connections`, `upload`, `files`, `dashboard`).

## Key files (touch with extra care)

- `lib/crypto/aes-gcm.ts` — credential AES-GCM envelope. Any change requires a migration plan for existing rows (would need re-encrypt). AAD == `connection.id` ULID.
- `lib/db/schema.ts` — Drizzle source of truth. Edit → `pnpm db:gen` → review generated SQL → commit both. The file deliberately omits `import "server-only"` because drizzle-kit imports it from a Node CLI context.
- `lib/auth/config.ts` vs `lib/auth/index.ts` — see "Two auth configs" above. Don't merge them.
- `lib/api/middleware.ts` — `withApi` pipeline. New cross-cutting concerns (e.g. tracing) belong here, not in each handler.
- `app/api/r2/presign/route.ts` — the only edge route that decrypts credentials. Default TTL 900s (15 min); hard cap 7200s.
- `wrangler.toml` — `compatibility_date = "2026-05-20"`, `compatibility_flags = ["nodejs_compat"]`, `pages_build_output_dir = ".vercel/output/static"`, `[[d1_databases]] binding = "DB" database_name = "prisim-r2-db"`. The `database_id` is a placeholder — replace after `wrangler d1 create`.

## Code Style

- TypeScript strict. No `any` without a `// reason:` comment.
- `import "server-only"` at the top of any module that touches D1, env secrets, or anything edge-runtime-only. Vitest aliases this to a no-op stub (`tests/stubs/server-only.ts`).
- Tailwind: prefer semantic shadcn tokens (`bg-background`, `text-muted-foreground`) over raw colors. v4 `@theme inline` already maps these to CSS variables in `app/globals.css`.
- TanStack Query: one hook per resource, query keys as `const` tuples (`['connections']`, `['objects', bucket, prefix]`).
- Zustand: UI state only.
- Validate every API input with Zod via `parseJson(req, Schema)`. Throw `ApiErrors.*`, never `new Error(...)`.
- `@aws-sdk/client-s3` is heavy — import individual Commands (`GetObjectCommand`, `PutObjectCommand`, …), never `* as S3` or top-level barrel.

## Environment

`.dev.vars` (local; gitignored) and Cloudflare Pages env vars (prod):

```
AUTH_SECRET=          # next-auth JWT signing (base64, 48+ bytes)
AUTH_URL=             # full origin, e.g. http://localhost:8788 in dev
ENCRYPTION_KEY=       # 32-byte AES-256 master key, base64
NEXT_PUBLIC_APP_URL=  # used for CORS notes shown in user-facing R2 setup
```

D1 is wired via the `DB` binding in `wrangler.toml`, not a `DATABASE_URL`.

**Rotating `ENCRYPTION_KEY` requires re-encrypting every `connections` row** — write the migration script before swapping the env.

## Workflow Rules

1. **Read before write.** Read the target file and its direct collaborators before editing. Don't infer structure from filenames — `app/api/r2/` has _only_ `presign/`, not `list/` or `delete/` (yet).
2. **Taskmaster discipline.** This project uses taskmaster (`.taskmaster/`). After each subtask, call `update_subtask` to record the decision, the alternatives considered, and any pitfall hit. `update_subtask` rejects parent IDs — if a task has no subtasks, call `expand_task` first.
3. **Conventional Commits.** `type(scope): subject` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`). Scope is the feature area (`auth`, `r2`, `ui`, `api`, `db`, `crypto`, `audit`, `connections`, …). Breaking changes use `!` and a `BREAKING CHANGE:` footer.
4. **Tests are part of "done".** New feature → Vitest unit test for pure logic and route handlers. Bug fix → regression test that fails before the patch. Playwright is allowed under `tests/e2e/` once configured, but only for behaviors Vitest can't reach (real browser download manager, cross-tab reload, etc.); don't add E2E "for completeness".
5. **No new dependencies without justification.** Match the stack above. Pin exact versions for security-relevant packages (`@aws-sdk/*`, crypto helpers, `ulid`, `zod`, `zustand`, `@tanstack/react-query` — see `package.json` for the existing pins).

## Gotchas

- **Edge runtime is required on Pages.** Every route handler that touches D1 / `getRequestContext` declares `export const runtime = "edge"`. Node-only APIs fail at deploy time. Use Web Crypto (`crypto.subtle`) — never `node:crypto`.
- **`next dev` lacks D1 bindings.** Login and any `/api/*` that touches D1 return 500. Use `pnpm preview` (port 8788). This is captured in memory; do not change `pnpm dev` to start `wrangler` — the split is intentional for fast UI-only iteration.
- **R2 CORS must be configured per bucket.** Presigned PUT from the browser silently fails CORS preflight until the bucket allows the app origin + `PUT`/`GET`. This is user-facing setup, not a code fix.
- **`@aws-sdk/client-s3` bundle is heavy.** Pages caps a worker bundle around 1 MB. Import individual Commands only; check the bundle when adding a new SDK call.
- **Tailwind v4 uses `@theme` in CSS.** Do not add a `tailwind.config.{js,ts}` — postcss is configured via `@tailwindcss/postcss` only.
- **shadcn primitives are generated.** `components/ui/` is in `.prettierignore` and should be regenerated via `pnpm dlx shadcn@latest add <name>`, not hand-edited.
- **R2 list uses `ContinuationToken`, not pages.** UI must support cursor-based paging. Tokens are opaque — pass through verbatim.
- **Drizzle D1 blob columns.** Locally (better-sqlite3) returns `Buffer`; in production (D1) returns `ArrayBuffer`. Normalize with `asU8(...)` (see `app/api/r2/presign/route.ts`) before passing into Web Crypto.
- **Zod v4 quirks**: `z.string().nonempty()` is gone — use `.min(1)`. `.default()` semantics changed.

## Definition of Done

Before marking a task complete:

- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green
- [ ] New code has unit tests (route handlers test the happy path + at least one failure branch)
- [ ] No plaintext credentials in code, logs, responses, or git history
- [ ] Every new error path uses `ApiErrors.*` (no inline `new Error` thrown to the client)
- [ ] Destructive endpoints require a confirmation token (`confirmation.required`)
- [ ] Mutating endpoints declare a `RateLimitBundles.*` policy in `withApi` options
- [ ] Audit-log row written for every state-changing path (success AND failure)
- [ ] `update_subtask` called with decisions, alternatives, and pitfalls
- [ ] Commit message follows Conventional Commits
