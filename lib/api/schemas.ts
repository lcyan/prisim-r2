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
