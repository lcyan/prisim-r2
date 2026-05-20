# CLAUDE.md

Project memory for Claude Code. Read this before any task.

## Project

Web app for managing Cloudflare R2 buckets (browse / upload / download / delete / share).
Multi-tenant: each user binds their own R2 credentials; the app never holds master keys.

## Stack

- **Framework**: Next.js 15 (App Router) + TypeScript (strict)
- **UI**: Tailwind CSS v4 + shadcn/ui (Radix primitives)
- **Data**: TanStack Query (server state) + Zustand (client UI state)
- **R2 SDK**: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2 = S3-compatible)
- **Deploy**: Cloudflare Pages (edge runtime)
- **Test**: Vitest (unit) + Playwright (E2E)

## Commands

```bash
pnpm dev              # local dev on :3000
pnpm build            # production build
pnpm lint             # eslint + prettier check
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm test:watch       # vitest watch
pnpm test:e2e         # playwright test
pnpm preview          # wrangler pages dev (test edge runtime locally)
pnpm deploy           # wrangler pages deploy
```

## Security Invariants (non-negotiable)

These rules override any other suggestion. If a request conflicts with them, push back.

1. **Credentials are AES-GCM encrypted at rest.** R2 access keys / secrets MUST be encrypted with AES-GCM (256-bit) using a server-only key (`ENCRYPTION_KEY` env). Never write plaintext credentials to DB, logs, error messages, or telemetry.
2. **Credentials never reach the browser.** API responses MUST NOT contain decrypted secrets. List endpoints return masked values (e.g. `AKIA****WXYZ`). Decryption happens only in server route handlers, in memory, for the duration of one R2 call.
3. **All object I/O goes through presigned URLs.** Uploads and downloads are direct browser ↔ R2 via presigned URL (PUT for upload, GET for download). The Next.js server NEVER proxies object bytes — it only mints URLs. This keeps Pages within request size limits and avoids egress through our edge.
4. **Destructive ops require explicit confirmation.** Delete bucket, empty prefix, bulk delete, and credential rotation MUST require a typed confirmation (e.g. user types the bucket name) on the client AND a confirmation token validated server-side. Never destructive-by-default.

## Workflow Rules

1. **Read before write.** Before editing any file, read it (and its direct collaborators) first. Do not infer structure from filenames.
2. **Taskmaster discipline.** This project uses taskmaster. After each subtask, call `update_subtask` to record the decision, the alternatives considered, and any pitfall hit. Future sessions rely on this trail.
3. **Conventional Commits.** All commit messages use `type(scope): subject` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`). Scope is the feature area (`auth`, `r2`, `ui`, `api`, …). Breaking changes use `!` and a `BREAKING CHANGE:` footer.
4. **Tests are part of "done".**
   - New feature → Vitest unit test for pure logic and route handlers.
   - Critical user flows (login, credential add, upload, delete) → Playwright E2E.
   - Bug fix → regression test that fails before the patch.
5. **No new dependencies without justification.** Match the stack above. Pin exact versions for security-relevant packages (`@aws-sdk/*`, crypto helpers).

## Architecture

```
app/
  (auth)/             # login, session
  (dashboard)/        # bucket browser, object list, settings
  api/
    credentials/      # CRUD on encrypted credential records
    r2/
      presign/        # POST → returns presigned PUT/GET URL
      list/           # POST → list objects (server-side R2 call)
      delete/         # POST → requires confirmation token
lib/
  crypto/             # AES-GCM encrypt/decrypt; key loaded from env
  r2/                 # S3 client factory, presign helpers
  db/                 # D1 / Postgres access (credentials, audit log)
  auth/               # session, CSRF
components/
  ui/                 # shadcn primitives (do not edit directly; re-generate)
  features/           # feature components (BucketList, ObjectTable, …)
stores/               # Zustand stores (UI state only, never secrets)
hooks/                # TanStack Query hooks
tests/
  unit/               # vitest
  e2e/                # playwright
```

## Key Files

- `lib/crypto/aes-gcm.ts` — credential encryption. Touch with extreme care; changes require a migration plan for existing rows.
- `lib/r2/client.ts` — S3 client factory. R2 endpoint format: `https://<account_id>.r2.cloudflarestorage.com`. Region MUST be `auto`.
- `app/api/r2/presign/route.ts` — presign endpoint. Default URL TTL 5 min (uploads), 15 min (downloads).
- `wrangler.toml` / `next.config.ts` — Pages + edge runtime config.

## Code Style

- TypeScript strict; no `any` without a `// reason:` comment.
- Server-only modules import `import 'server-only'` at the top.
- Tailwind: prefer semantic shadcn tokens (`bg-background`, `text-muted-foreground`) over raw colors.
- TanStack Query: one hook per resource in `hooks/`, query keys as tuples (`['objects', bucket, prefix]`).
- Zustand: never store credentials, tokens, or PII. UI state only.
- Validate every API input with Zod at the route boundary.

## Environment

```
ENCRYPTION_KEY=        # 32 bytes base64; AES-GCM master key (server-only)
DATABASE_URL=          # D1 binding or Postgres URL
SESSION_SECRET=        # auth cookie signing
NEXT_PUBLIC_APP_URL=   # used for CORS on presigned URLs
```

`ENCRYPTION_KEY` rotation requires re-encrypting the credentials table. Never commit `.dev.vars` / `.env.local`.

## Gotchas

- **Edge runtime is required on Pages.** Add `export const runtime = 'edge'` to every route handler and page that hits Cloudflare-only APIs (D1, KV). Node-only APIs (`fs`, `crypto.createCipheriv` in some older forms) will fail at deploy time. Use Web Crypto (`crypto.subtle`) for AES-GCM.
- **R2 CORS must be configured per bucket.** Presigned PUT from the browser will silently fail (CORS preflight) until the bucket has a CORS policy allowing the app origin and the `PUT`/`GET` methods. Document this in user-facing setup, not just in code.
- **`@aws-sdk/client-s3` bundle is heavy.** Import only the commands you use (`GetObjectCommand`, `PutObjectCommand`, …) to keep the edge bundle under Pages' 1 MB worker limit.
- **Tailwind v4 uses `@theme` in CSS, not `tailwind.config.js`.** Don't add a v3-style config file.
- **shadcn components** are copied into `components/ui/`. Re-run the CLI to update; don't hand-edit primitives.
- **R2 list pagination** uses `ContinuationToken`, not page numbers. UI must support cursor-based paging.

## Definition of Done

Before marking a task complete:

- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green
- [ ] New code has unit tests; critical flows have E2E
- [ ] No plaintext credentials in code, logs, responses, or git history
- [ ] Destructive endpoints require confirmation token
- [ ] `update_subtask` called with decisions and pitfalls
- [ ] Commit message follows Conventional Commits
