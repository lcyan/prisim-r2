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
