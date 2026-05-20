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

/* ─── connections (placeholder for task 7+) ─────────────────── */
//
// Real shapes land when the credential CRUD task ships. Keeping the
// declarations here (commented out) so the future PR is a one-line uncomment
// rather than another design decision.
//
// export const ConnectionsCreateSchema = z.object({
//   name: z.string().min(1).max(64),
//   accountId: z.string().min(1).max(64),
//   endpoint: z.string().url(),
//   accessKey: z.string().min(16).max(128),
//   secretKey: z.string().min(16).max(128),
// });
// export type ConnectionsCreateInput = z.infer<typeof ConnectionsCreateSchema>;

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
