// lib/api/types.ts
//
// Public API output shapes — wire types returned by /api/*.
//
// Why this file exists:
//   The route modules under app/api/* import "server-only", which makes
//   them unsafe to import (even as types in some toolchains) from client
//   components and hooks. Centralizing the response interfaces here keeps
//   a single source of truth without forcing client code to pull in the
//   server-only boundary.
//
//   Route handlers MUST import these types instead of redefining them —
//   the typecheck will catch any drift between what the server returns
//   and what the client expects.
//
// What does NOT belong here:
//   - Zod input schemas → lib/api/schemas.ts
//   - Error shapes → lib/api/errors.ts (ApiErrorPayload)
//   - DB row types → lib/db/schema.ts (drizzle-inferred)

/**
 * Public projection of `connections` rows returned by:
 *   GET  /api/connections
 *   POST /api/connections
 *   PATCH /api/connections/[id]
 *
 * Timestamps are normalized to epoch milliseconds so the wire shape is
 * stable across runtimes (drizzle returns Date in Node, ms in some D1
 * code paths). Clients convert back to Date as needed.
 *
 * Secret material — access key ciphertext, secret key ciphertext, IVs —
 * is NEVER included. `accessKeyMasked` shows first 4 + last 4 chars only
 * (see `maskAccessKey` in schemas.ts).
 */
export interface ConnectionSummary {
  id: string;
  name: string;
  accountId: string;
  accessKeyMasked: string;
  /** Epoch ms — when the connection was created. */
  createdAt: number;
  /** Epoch ms of the last R2 op against this connection, or null if the
   *  connection has never been used (just-created or probe-only). */
  lastUsedAt: number | null;
}

/**
 * Public projection of one R2 bucket as returned by:
 *   GET /api/r2/buckets?cid=…
 *
 * Mirrors what `listBuckets` (`@aws-sdk/client-s3` → `ListBucketsCommand`)
 * gives us, normalized to JSON-friendly values:
 *   - `name` is always a non-empty string. The route filters out entries
 *     R2 returns without a Name (defensive — never observed in practice).
 *   - `createdAt` is epoch milliseconds when R2 surfaces one, or null
 *     when it doesn't. Some accounts/buckets predate the field; treating
 *     "missing" as null instead of dropping the bucket keeps the listing
 *     useful in those cases.
 *
 * The route NEVER includes anything credential-derived here — only the
 * bucket-level metadata R2 itself returns.
 */
export interface BucketSummary {
  name: string;
  createdAt: number | null;
}

/**
 * Public projection of one R2 object as returned by:
 *   GET /api/r2/list?cid=…&bucket=…&prefix=…&cursor=…
 *
 * Mirrors what `listObjects` (`@aws-sdk/client-s3` → `ListObjectsV2Command`)
 * gives us, normalized to JSON-friendly values:
 *   - `key` is always a non-empty string (route filters out items R2
 *     returns without a Key — defensive, never observed in practice).
 *   - `size` is bytes when R2 surfaces it, or null if missing. Type stays
 *     `number | null` rather than `bigint` because Pages workers JSON-
 *     serialize numbers and R2 object sizes fit comfortably in a JS
 *     safe integer (5 TB max < 2^53).
 *   - `etag` includes the surrounding quotes R2 returns (e.g. `"abc..."`).
 *     The client treats it as opaque — strip-quotes only if you need to
 *     compare against a multipart-complete return value.
 *   - `lastModified` is epoch milliseconds, or null if R2 omits it.
 */
export interface R2ListObject {
  key: string;
  size: number | null;
  etag: string | null;
  lastModified: number | null;
}

/**
 * Public projection of one page of an R2 list as returned by:
 *   GET /api/r2/list?cid=…&bucket=…&prefix=…&cursor=…
 *
 * Shapes:
 *   - `objects` — flat keys directly under `prefix` (file-like entries).
 *     Empty array when the prefix is empty/missing.
 *   - `prefixes` — common prefixes (folder-like entries) under `prefix`
 *     when Delimiter='/' is applied server-side. Each entry already
 *     includes the trailing '/'. Empty when there are no sub-folders.
 *   - `nextCursor` — opaque token to pass back as `cursor` on the next
 *     request to continue the listing, or null when this is the final
 *     page. NEVER concatenate with the prefix — R2 ContinuationTokens
 *     are opaque blobs unrelated to the prefix path.
 *
 * Both arrays are always present (never undefined). The "empty bucket"
 * response is `{ objects: [], prefixes: [], nextCursor: null }`.
 */
export interface R2ListResponse {
  objects: R2ListObject[];
  prefixes: string[];
  nextCursor: string | null;
}

/**
 * Public projection of POST /api/r2/presign.
 *
 * Returned for all three discriminated `op` variants (put / get / upload-part);
 * the wire shape is intentionally identical so a single hook / typed response
 * can drive uploads, downloads, and multipart PartUpload calls.
 *
 *   - `url` is the short-lived signed URL the browser uses directly against
 *     R2. NEVER persisted server-side (CLAUDE.md security invariant #3); the
 *     audit_log records that a presign happened, not the URL itself.
 *   - `expiresAt` is epoch milliseconds — `Date.now() + ttl*1000` from the
 *     server's clock. Clients compare against their own clock when deciding
 *     to refresh; small drift (a few seconds) is acceptable because the TTL
 *     itself bakes in a generous default (15 min).
 */
export interface R2PresignResponse {
  url: string;
  expiresAt: number;
}

/**
 * Public projection of POST /api/r2/delete/prepare.
 *
 *   - `confirmToken` — opaque to the client; pass it back verbatim to
 *     POST /api/r2/delete alongside the same cid/bucket/keys triple. The
 *     server re-verifies the HMAC, so a token issued for one key list
 *     cannot be replayed against another. Treat as a bearer credential
 *     for the intent — do NOT log it.
 *   - `expiresAt` — epoch milliseconds at which the token stops verifying
 *     (currently 5 min from issue). The UI may render a countdown but
 *     should always be ready for the server to reject a "still-fresh"
 *     token if the clocks drift apart.
 */
export interface R2DeletePrepareResponse {
  confirmToken: string;
  expiresAt: number;
}

/**
 * Public projection of POST /api/r2/delete.
 *
 *   - `deleted` — keys R2 confirmed it removed. Order is not guaranteed.
 *     A key may appear here even if it didn't exist on the bucket; S3
 *     DeleteObjects is idempotent and surfaces no-op deletes in the same
 *     Deleted set as actual removals (consistent with the spec).
 *   - `errors` — per-key failure entries. Empty array on full success;
 *     callers must check this before assuming "all deleted". Each entry
 *     carries the upstream R2 code/message verbatim so the UI can show
 *     a meaningful per-row failure (e.g. AccessDenied vs NoSuchKey).
 */
export interface R2DeleteResponse {
  deleted: string[];
  errors: Array<{
    key?: string;
    code?: string;
    message?: string;
  }>;
}

/**
 * Public projection of POST /api/r2/multipart/create.
 *
 *   - `uploadId` is the opaque token R2 mints when CreateMultipartUpload
 *     succeeds. The browser carries it (alongside the bucket+key) into each
 *     per-part presign call so all parts attach to the same upload, and
 *     into the eventual complete/abort call. It's safe to log — it does
 *     not authenticate anything by itself.
 */
export interface R2MultipartCreateResponse {
  uploadId: string;
}

/**
 * Public projection of POST /api/r2/multipart/complete.
 *
 *   - `etag` — the multipart-complete ETag R2 returns. NOT the MD5 of the
 *     object body (S3 uses `<md5-of-parts>-<count>` form for multipart);
 *     clients should treat it as opaque rather than compare against any
 *     local checksum.
 *   - `location` — the URL R2 returns identifying the finalized object.
 *     Both fields are optional because the SDK types them as optional;
 *     R2 in practice always returns both for a successful Complete call.
 */
export interface R2MultipartCompleteResponse {
  etag: string | null;
  location: string | null;
}

/**
 * Public projection of POST /api/share/create.
 *
 *   - `id` — ULID of the persisted `shares` row. Pass to DELETE /api/share/:id
 *     to drop the bookkeeping record.
 *   - `url` — the minted presigned GET URL. **Bearer credential** for the
 *     object until `expiresAt`; treat with the same care as a session token
 *     (don't log, don't leave on screen indefinitely, only return it on
 *     create — list endpoints never include it).
 *   - `expiresAt` — epoch ms when the upstream signature stops verifying.
 *     `Date.now() + ttlSeconds*1000` from the server's clock.
 */
export interface ShareCreateResponse {
  id: string;
  url: string;
  expiresAt: number;
}

/**
 * Public projection of one row in GET /api/share.
 *
 *   - Deliberately omits `url` — the URL is only minted at create time and
 *     the row's `url_hash` column stores only a sha256 of it. Re-rendering
 *     the URL in the list would either require persisting plaintext (no) or
 *     re-signing (changes the URL each call). The user keeps the original
 *     URL from the create response; this list is the bookkeeping view.
 *   - `ttlSeconds` is one of `SHARE_TTL_SECONDS` (3600 | 86400 | 604800).
 *   - All timestamps are epoch ms.
 */
export interface ShareSummary {
  id: string;
  bucket: string;
  key: string;
  ttlSeconds: number;
  createdAt: number;
  expiresAt: number;
}

/**
 * Public projection of GET /api/share.
 *
 *   - `items` — up to SHARE_LIST_PAGE_SIZE entries, newest first.
 *   - `nextCursor` — opaque continuation token; pass back as `?cursor=` on
 *     the next request. `null` means this is the final page.
 */
export interface ShareListResponse {
  items: ShareSummary[];
  nextCursor: string | null;
}

/**
 * Public projection of DELETE /api/share/:id. Mirrors the connection-delete
 * shape so consumers can switch on `ok` uniformly.
 */
export interface ShareDeleteResponse {
  ok: true;
  id: string;
}

/**
 * Public projection of POST /api/share/:id/reveal.
 *
 * Re-mints a presigned GET against the share row's bucket/key for the row's
 * REMAINING TTL — so the new URL stops working at the same wall-clock time
 * as the original. The shape mirrors ShareCreateResponse so the UI can reuse
 * the same "URL ready" view between create and reveal.
 *
 *   - `url` — fresh presigned URL (a different signature than the original;
 *     the old URL keeps working until its own expiry, the new one matches).
 *   - `expiresAt` — unchanged from the share row; epoch ms.
 */
export interface ShareRevealResponse {
  id: string;
  url: string;
  expiresAt: number;
}

/**
 * Public projection of one row in GET /api/audit.
 *
 *   - `op` is the writer-side AuditOp string literal verbatim (e.g.
 *     `"object.delete"`, `"presign.get"`); clients treat it as opaque and
 *     match against AUDIT_OP_VALUES from schemas.ts for badge styling.
 *   - `bucket` / `key` / `connectionId` / `errorMsg` / `ip` / `ua` are
 *     all nullable — many ops legitimately have no bucket (e.g. auth.*),
 *     and pre-session events carry no UA/IP.
 *   - `createdAt` is epoch milliseconds — `Date.getTime()` from the
 *     server-side timestamp column.
 */
export interface AuditEntry {
  id: string;
  op: string;
  status: "success" | "failure";
  bucket: string | null;
  key: string | null;
  connectionId: string | null;
  errorMsg: string | null;
  ip: string | null;
  ua: string | null;
  createdAt: number;
}

/**
 * Public projection of GET /api/audit.
 *
 *   - `items` — up to AUDIT_LIST_PAGE_SIZE entries, newest first.
 *   - `nextCursor` — opaque continuation token; pass back as `?cursor=` on
 *     the next request. `null` means this is the final page.
 */
export interface AuditListResponse {
  items: AuditEntry[];
  nextCursor: string | null;
}

/**
 * Public projection of GET /api/dashboard/summary.
 *
 *   - `bucketsCount` — number of R2 buckets in the active connection.
 *   - `shares` — active share count + 7d-expiring subcount.
 *   - `ops` — total audit ops within range + previous equal-length window count
 *     (raw counts; the client calls formatDelta to derive the percentage so
 *     we don't double-round through floating-point).
 *   - `failures` — count of failed ops within range + failure rate %.
 *   - `opsByDay` — daily aggregate, YYYY-MM-DD keys, length matches range (7 or 30).
 *   - `opsByType` — 7d op breakdown, descending by count.
 *   - `recentActivity` — last 10 audit rows.
 *   - `totp.recoveryCodesRemaining` — unconsumed recovery codes count; ≤ 3 triggers the low-codes banner.
 */
export interface DashboardSummary {
  bucketsCount: number;
  shares: { active: number; expiring7d: number };
  ops: { count: number; previousCount: number };
  failures: { count: number; ratePct: number };
  opsByDay: Array<{ date: string; count: number }>;
  opsByType: Array<{ op: string; count: number }>;
  recentActivity: AuditEntry[];
  totp: { recoveryCodesRemaining: number };
}

/**
 * Response shape for POST /api/r2/mkdir. `alreadyExisted` distinguishes
 * "created" from "no-op the row was already there" so the toast copy
 * can differ without making the route 409 / 200 a header dance.
 *
 *   - `key` — final key written: `parentPrefix + name + "/"`.
 *   - `alreadyExisted` — true when HeadObject probe found the placeholder
 *     already there; false when PutObject wrote a fresh 0-byte object.
 */
export interface R2MkdirResponse {
  key: string;
  alreadyExisted: boolean;
}
