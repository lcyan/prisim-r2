// lib/api/schemas.ts
//
// Central registry of API input schemas. Two reasons to keep them here
// instead of next to each route:
//   1) z.infer types are reused by route handlers AND by hooks/components,
//      so a single import path keeps client + server in sync.
//   2) It's easy to audit "what shapes do we accept at the boundary?" by
//      reading one file rather than walking app/api/*.
//
// Naming convention: `<Domain><Verb>Schema` (e.g. ConnectionsCreateSchema).
// Each schema MUST be a top-level export and MUST have a matching
// `<...>Input` type derived via z.infer.
//
// Add a new schema here before adding the route handler that consumes it —
// the typecheck error in the handler is the cue that you forgot.

import { z } from "zod";

/* ─── shared primitives ──────────────────────────────────────── */

/** ULID — 26-char Crockford base32. Used for our DB primary keys. */
export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");

/** Bucket name: S3/R2 naming rules — lowercase letters, digits, dot, hyphen,
 * length 3–63. Tighter than R2's exact spec but rejects anything that would
 * confuse our UI / presign builder. */
export const BucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    "must match S3 bucket naming rules",
  );

/** Object key: 1–1024 UTF-8 chars; reject leading slash so callers don't
 * accidentally rely on it (R2 ignores it, but it's a footgun). */
export const ObjectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !s.startsWith("/"), "must not start with '/'");

/** Confirmation tokens for destructive ops — random hex from the server. */
export const ConfirmationTokenSchema = z.string().min(16).max(128);

/* ─── auth ───────────────────────────────────────────────────── */

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});
export type LoginInput = z.infer<typeof LoginSchema>;

/* ─── connections ────────────────────────────────────────────── */
//
// POST /api/connections (create):
//   - accountId: Cloudflare R2 account ID — exactly 32 lowercase hex chars.
//     The endpoint host is derived from this (https://<id>.r2.cloudflarestorage.com),
//     so a bogus value would produce DNS errors several layers deep.
//   - accessKeyId: 20+ chars (the prefix of an R2 token; 20 is the minimum we
//     observed). Upper bound caps log noise from accidentally pasted garbage.
//   - secretAccessKey: 40+ chars. Same upper bound for the same reason.
//
// PATCH /api/connections/[id] (rename only):
//   - Strict object: rejects any field other than `name`. We do NOT allow
//     re-binding accountId / keys via PATCH — a key rotation should be a new
//     connection so it goes through the create-time R2 probe (and audit).

export const ConnectionsCreateSchema = z
  .object({
    name: z.string().min(1).max(64),
    accountId: z.string().regex(/^[a-f0-9]{32}$/, "must be 32 hex chars"),
    accessKeyId: z.string().min(20).max(128),
    secretAccessKey: z.string().min(40).max(256),
  })
  .strict();
export type ConnectionsCreateInput = z.infer<typeof ConnectionsCreateSchema>;

export const ConnectionsPatchSchema = z
  .object({
    name: z.string().min(1).max(64),
  })
  .strict();
export type ConnectionsPatchInput = z.infer<typeof ConnectionsPatchSchema>;

export const ConnectionIdParamSchema = z.object({ id: UlidSchema });
export type ConnectionIdParam = z.infer<typeof ConnectionIdParamSchema>;

/**
 * Mask an R2 access key for safe display / persistence in `connections.access_key_masked`.
 *
 *   "AKIAFAKEACCESSKEY1234" → "AKIA****1234"
 *
 * - First 4 + last 4 chars preserved, middle replaced with `****`.
 * - For keys shorter than 8 chars we collapse to all-mask to avoid exposing
 *   more than half the secret; the create schema already requires >=20 so this
 *   branch is purely defensive (e.g. if an admin imports a malformed row).
 *
 * Pure function on purpose — re-used by route handlers and tests; no I/O.
 */
export function maskAccessKey(accessKeyId: string): string {
  if (typeof accessKeyId !== "string" || accessKeyId.length < 8) {
    return "****";
  }
  return `${accessKeyId.slice(0, 4)}****${accessKeyId.slice(-4)}`;
}

/* ─── r2 buckets (list) ──────────────────────────────────────── */
//
// GET /api/r2/buckets?cid=<ULID>
//
// The connection id is the only input — there's no body and no other
// knob. We still go through Zod (rather than `searchParams.get + manual
// check`) so the validation failure surfaces as the standard
// validation.invalid envelope, identical to a body-validated route.

export const R2BucketsQuerySchema = z.object({
  cid: UlidSchema,
});
export type R2BucketsQueryInput = z.infer<typeof R2BucketsQuerySchema>;

/* ─── r2 objects (list) ──────────────────────────────────────── */
//
// GET /api/r2/list?cid=<ULID>&bucket=<name>&prefix=<str>&cursor=<opaque>
//
// Folder-style listing — pass `prefix` to scope into a "directory" and
// the route sets Delimiter='/' under the hood so deeper keys collapse
// into CommonPrefixes. `cursor` is the previous response's nextCursor,
// passed through verbatim (R2 emits opaque tokens).
//
// Field rules:
//   - `prefix` defaults to "" so callers can hit the bucket root without
//     supplying the param. Max 1024 chars matches the ObjectKey upper
//     bound — the longest prefix is "the longest key minus one char".
//     We deliberately do NOT reuse `ObjectKeySchema` (which forbids the
//     leading "/" and requires min 1) because a prefix legitimately may
//     be "" and a leading "/" is benign here (R2 ignores it for list).
//   - `cursor` is opaque; we only bound the length to keep a malformed
//     value from blowing past the SDK's URL-builder limits. Real R2
//     ContinuationTokens are well under 1024 chars in observed traffic.

/** Server-side page size for the list call. Centralized so the schema,
 *  route, and any future docs (curl examples in the README) stay in
 *  sync. The client cannot override this — keeping it server-side puts
 *  a hard cap on per-request work regardless of caller behavior. */
export const R2_LIST_DEFAULT_MAX_KEYS = 200;

export const R2ListQuerySchema = z.object({
  cid: UlidSchema,
  bucket: BucketNameSchema,
  // `.default("")` makes the field optional at the wire level and lands
  // on the empty string after parse, so the route can pass it straight
  // into ListObjectsV2 without a `?? ""` dance.
  prefix: z.string().max(1024).default(""),
  cursor: z.string().min(1).max(1024).optional(),
});
export type R2ListQueryInput = z.infer<typeof R2ListQuerySchema>;

/**
 * Parse a Request's query string against a Zod schema. Symmetric to
 * `parseJson` but for GET routes where the input lives in the URL.
 *
 * Returns `z.infer<T>` on success; throws `ZodError` on failure, which
 * withApi maps to a `validation.invalid` 400 with a flattened issue map.
 *
 * Multi-value params (e.g. `?k=1&k=2`) collapse to the FIRST value, since
 * none of our endpoints use repeated keys. If that ever changes, switch
 * the body to `searchParams.getAll` and bake `z.array(...)` into the
 * schema — for now `Object.fromEntries` is the right shape.
 */
export async function parseQuery<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  const url = new URL(req.url);
  // Object.fromEntries yields a string-keyed record of single values;
  // good enough for ULID/string/single-number params our schemas use.
  const raw = Object.fromEntries(url.searchParams.entries());
  return schema.parse(raw);
}

/* ─── r2 presign ─────────────────────────────────────────────── */

// Hard upper bound on URL lifetime (seconds). The task brief calls out
// 7200 (2h) as a deliberate anti-abuse cap: a leaked presigned URL is a
// bearer credential for that object, so longer TTLs raise blast radius.
// Bake the number into the schema (not the route) so any future presign
// route stays consistent.
export const R2_PRESIGN_MAX_TTL_SECONDS = 7200;

/** Default URL lifetime when the caller omits `ttl`. 15 min mirrors the
 *  contract documented in CLAUDE.md (`presign 默认 put=15min, get=15min`).
 *  Centralized so the route handler and any docs stay in sync. */
export const R2_PRESIGN_DEFAULT_TTL_SECONDS = 900;

// Fields common to every op. Defined as a shape (plain object) so each
// discriminated-union arm can spread it — `.extend()` works too, but the
// spread form is what the zod 4 docs recommend for sharing a base with
// strict typing intact.
const R2PresignBaseShape = {
  cid: UlidSchema,
  bucket: BucketNameSchema,
  key: ObjectKeySchema,
  ttl: z
    .number()
    .int()
    .positive()
    .max(R2_PRESIGN_MAX_TTL_SECONDS)
    .optional(),
} as const;

/**
 * POST /api/r2/presign — input schema.
 *
 * Discriminated by `op`:
 *   - `put`          → presign a single-shot PUT (browser uploads one body)
 *   - `get`          → presign a download
 *   - `upload-part`  → presign one PUT of a multipart upload, identified by
 *                      (uploadId, partNumber); the route layer counts this as
 *                      `presign.put` for audit purposes.
 *
 * partNumber range mirrors the S3 spec: 1..10000, 1-based.
 * uploadId is treated as opaque — R2 mints it via createMultipartUpload —
 * but we cap the length to keep a malformed value from blowing past the
 * SDK's URL-builder limits and showing up as an opaque 4xx.
 */
export const R2PresignSchema = z.discriminatedUnion("op", [
  z.object({
    ...R2PresignBaseShape,
    op: z.literal("put"),
  }),
  z.object({
    ...R2PresignBaseShape,
    op: z.literal("get"),
  }),
  z.object({
    ...R2PresignBaseShape,
    op: z.literal("upload-part"),
    uploadId: z.string().min(1).max(256),
    partNumber: z.number().int().min(1).max(10_000),
  }),
]);
export type R2PresignInput = z.infer<typeof R2PresignSchema>;

/* ─── r2 multipart control-plane ─────────────────────────────── */
//
// POST /api/r2/multipart/create  → starts a multipart upload; returns the
//   opaque uploadId that the browser then carries into per-part presigns.
// POST /api/r2/multipart/complete → finalizes after every part PUT
//   succeeded; takes the parts list (collected from per-part ETags) and
//   returns { etag, location }.
// POST /api/r2/multipart/abort   → cancels an in-progress upload (204).
//
// Field rules:
//   - `cid`, `bucket`, `key` reuse the shared primitives so the wire
//     contract stays identical to the presign endpoint (same ULID format,
//     same S3 bucket-naming + object-key rules).
//   - `contentType` is forwarded into CreateMultipartUploadCommand so R2
//     serves the eventual GET with the right `Content-Type`. Length cap
//     mirrors common HTTP header sane defaults; the optional `.strict()`
//     keeps callers from sneaking extra fields past the schema.
//   - `uploadId` is opaque (minted by R2 on create). Bounded so a
//     malformed value can't blow past the SDK's URL builder limits.
//   - `parts`: 1..10000 mirrors the S3 spec for max-parts-per-upload;
//     `partNumber` is 1-based. `etag` is the value the browser receives
//     from each part's PUT response — we treat it as opaque (S3 quoting
//     varies and R2 may or may not emit the surrounding quotes; the
//     SDK accepts either, so we don't normalize here).

export const R2MultipartCreateSchema = z
  .object({
    cid: UlidSchema,
    bucket: BucketNameSchema,
    key: ObjectKeySchema,
    contentType: z.string().min(1).max(255).optional(),
  })
  .strict();
export type R2MultipartCreateInput = z.infer<typeof R2MultipartCreateSchema>;

/** Per-part record in the complete payload. Exported so the route handler
 *  + tests + future browser hook share one source of truth on the shape. */
export const R2MultipartPartSchema = z
  .object({
    partNumber: z.number().int().min(1).max(10_000),
    etag: z.string().min(1).max(256),
  })
  .strict();
export type R2MultipartPart = z.infer<typeof R2MultipartPartSchema>;

export const R2MultipartCompleteSchema = z
  .object({
    cid: UlidSchema,
    bucket: BucketNameSchema,
    key: ObjectKeySchema,
    uploadId: z.string().min(1).max(256),
    // Non-empty — completing with zero parts is meaningless and S3 returns
    // MalformedXML anyway. Catching it at validation gives a clean 400
    // instead of an opaque upstream failure.
    parts: z.array(R2MultipartPartSchema).min(1).max(10_000),
  })
  .strict();
export type R2MultipartCompleteInput = z.infer<typeof R2MultipartCompleteSchema>;

export const R2MultipartAbortSchema = z
  .object({
    cid: UlidSchema,
    bucket: BucketNameSchema,
    key: ObjectKeySchema,
    uploadId: z.string().min(1).max(256),
  })
  .strict();
export type R2MultipartAbortInput = z.infer<typeof R2MultipartAbortSchema>;

/* ─── r2 delete ──────────────────────────────────────────────── */
//
// POST /api/r2/delete/prepare  → mint a 5-min HMAC confirmToken for the
//   (userId, bucket, keys[]) intent. Returns { confirmToken, expiresAt }.
// POST /api/r2/delete           → re-verify the token and run deleteObjects
//   on the same keys list. Token + keys are bound (sort + sha256), so a
//   client cannot present a token issued for ["a","b"] and submit ["a","b","c"].
//
// Field rules:
//   - `cid`, `bucket` reuse the shared primitives.
//   - `keys` is bounded server-side (DELETE_KEYS_MAX) so a malicious caller
//     can't blow past R2's 1000-per-batch DeleteObjects cap or force the
//     server to spend an unbounded sha256 over a huge list. Each entry uses
//     ObjectKeySchema (1..1024, no leading "/"). The route layer further
//     refuses recursive delete in V1 — UI only sends literal flat keys.
//   - `confirmToken` shape is `<base64url>.<digits>` minted by
//     lib/api/delete-token.ts. We bound the length here so a malformed
//     value short-circuits before the HMAC compare.

/** Max keys per delete request. Aligns with the upstream S3 DeleteObjects
 *  cap (1000 per command) — the control-plane wrapper batches at that
 *  limit, so accepting more here only buys server work. Centralized so
 *  the schema, route, and UI's "show 20, summarize the rest" copy stay
 *  in sync about the upper bound on user intent. */
export const DELETE_KEYS_MAX = 1000;

export const R2DeletePrepareSchema = z
  .object({
    cid: UlidSchema,
    bucket: BucketNameSchema,
    keys: z.array(ObjectKeySchema).min(1).max(DELETE_KEYS_MAX),
  })
  .strict();
export type R2DeletePrepareInput = z.infer<typeof R2DeletePrepareSchema>;

export const R2DeleteConfirmSchema = z
  .object({
    cid: UlidSchema,
    bucket: BucketNameSchema,
    keys: z.array(ObjectKeySchema).min(1).max(DELETE_KEYS_MAX),
    confirmToken: z.string().min(16).max(512),
  })
  .strict();
export type R2DeleteConfirmInput = z.infer<typeof R2DeleteConfirmSchema>;

/* ─── shares ─────────────────────────────────────────────────── */
//
// POST /api/share/create — mint a presigned GET against an R2 object and
// persist a `shares` row so the user can review/revoke generated links.
// TTL is a closed enum (1h / 1d / 7d) so a stray client cannot mint
// arbitrarily-long bearer URLs (CLAUDE.md security invariant #3 still
// applies — the URL is short-lived against the *object*; the row is a
// bookkeeping record).
//
// GET /api/share — paginated listing of *active* (unexpired) shares for
// the current user. Cursor is opaque; produced/consumed by the route.
//
// DELETE /api/share/:id — drop the bookkeeping row. Does NOT (and CAN
// NOT) revoke the presigned URL at the protocol layer — once minted,
// the URL stays usable until the upstream signature expiry. The UI
// surfaces this warning explicitly.

/** Closed set of allowed TTLs: 1 hour, 1 day, 7 days. Anything else
 *  rejects at the Zod boundary with a clean 400 — keeps the dropdown UI
 *  and the server in lockstep without a "custom value" loophole. */
export const SHARE_TTL_SECONDS = [3600, 86400, 604800] as const;
export type ShareTtlSeconds = (typeof SHARE_TTL_SECONDS)[number];

export const ShareCreateSchema = z
  .object({
    cid: UlidSchema,
    bucket: BucketNameSchema,
    key: ObjectKeySchema,
    // z.union<literal,literal,literal> — Zod 4 disallows narrow union of
    // numeric literals here without a tuple cast on .literal args, so we
    // express it as three z.literal()s. Matches the task brief verbatim.
    ttlSeconds: z.union([
      z.literal(3600),
      z.literal(86400),
      z.literal(604800),
    ]),
  })
  .strict();
export type ShareCreateInput = z.infer<typeof ShareCreateSchema>;

/** Page size for GET /api/share. Server-side cap — the client cannot
 *  override. Mirrors the same fixed-cap convention as R2_LIST_DEFAULT_MAX_KEYS. */
export const SHARE_LIST_PAGE_SIZE = 50;

export const ShareListQuerySchema = z.object({
  // Opaque cursor — produced by the previous response's nextCursor.
  // Length bounded so a malformed value can't blow past the URL parser
  // before the route's own cursor decoder rejects it.
  cursor: z.string().min(1).max(256).optional(),
});
export type ShareListQueryInput = z.infer<typeof ShareListQuerySchema>;

/** Path param for DELETE /api/share/:id. */
export const ShareIdParamSchema = z.object({ id: UlidSchema });
export type ShareIdParam = z.infer<typeof ShareIdParamSchema>;

/* ─── audit log ──────────────────────────────────────────────── */
//
// GET /api/audit ?cursor=&op=&bucket=
//
// The op filter is constrained to the same closed string-literal union
// the writer side uses (lib/audit/log.ts → AuditOp). We duplicate the
// list here as Zod literals rather than importing AuditOp because
// schemas.ts must stay client-safe (no `import "server-only"`). A
// compile-time check at the bottom (AUDIT_OP_VALUES satisfies …) keeps
// the two lists in lockstep — adding a new AuditOp without touching
// this schema is a typecheck error.

/** Closed set of audit operations the filter dropdown accepts. Must
 *  match `AuditOp` in lib/audit/log.ts; see the `satisfies` check below. */
export const AUDIT_OP_VALUES = [
  "connection.create",
  "connection.update",
  "connection.delete",
  "object.delete",
  "upload.create",
  "upload.complete",
  "upload.abort",
  "presign.put",
  "presign.get",
  "share.create",
  "share.delete",
  "security.decrypt_failed",
  "auth.login",
  "auth.logout",
] as const;
export type AuditOpValue = (typeof AUDIT_OP_VALUES)[number];

export const AuditOpSchema = z.enum(AUDIT_OP_VALUES);

/** Page size for GET /api/audit. Server-side cap — the client cannot
 *  override. Matches the task brief (LIMIT 100). */
export const AUDIT_LIST_PAGE_SIZE = 100;

export const AuditListQuerySchema = z.object({
  // Opaque cursor — produced by the previous response's nextCursor.
  // Length bounded so a malformed value can't blow past the URL parser
  // before the route's own cursor decoder rejects it.
  cursor: z.string().min(1).max(256).optional(),
  // Single-op filter. The full enum is allowed so any operation a writer
  // could have emitted is filter-addressable; the UI dropdown is sourced
  // from AUDIT_OP_VALUES so a typo at either end is a compile error.
  op: AuditOpSchema.optional(),
  // Bucket filter. We reuse BucketNameSchema rather than free-form text
  // so a malformed value rejects at the validation boundary instead of
  // silently matching no rows.
  bucket: BucketNameSchema.optional(),
});
export type AuditListQueryInput = z.infer<typeof AuditListQuerySchema>;

/* ─── helper ─────────────────────────────────────────────────── */

/**
 * Parse a JSON request body with the given schema. Throws ZodError on
 * failure; withApi() catches it and maps to `validation.invalid` (400).
 *
 * Prefer this over `Schema.parse(await req.json())` at the callsite — it
 * also rejects non-JSON bodies with a clear error rather than letting
 * `await req.json()` blow up with a generic SyntaxError.
 */
export async function parseJson<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    // Empty / malformed JSON — treat as schema failure for a uniform 400.
    throw new z.ZodError([
      {
        code: "custom",
        message: "Request body must be valid JSON",
        path: [],
        input: undefined,
      },
    ]);
  }
  return schema.parse(raw);
}
