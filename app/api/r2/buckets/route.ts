// app/api/r2/buckets/route.ts
//
// GET /api/r2/buckets?cid=<ULID>
//
// Read-only listing of the R2 buckets visible to one of the user's saved
// connections. The handler:
//
//   1. validate query             → R2BucketsQuerySchema (Zod)
//   2. fetch & user-scope the row → connections.id = cid AND user_id = ctx
//   3. decrypt access/secret keys → AES-GCM with AAD = connection.id
//   4. listBuckets via R2 SDK     → control-plane only, no body I/O
//   5. update last_used_at        → fire-and-forget after the body lands
//   6. return BucketSummary[]
//
// Notes worth knowing before touching this file:
//
// * GET is exempt from CSRF (withApi only enforces it on mutating verbs),
//   so the client doesn't need to mint a token to refresh the dropdown.
//   Read-aggregate rate limiting is NOT applied here because every bucket
//   list eats one R2 round-trip + one credential decrypt, and the UI sits
//   behind TanStack Query's 5-minute staleTime — the natural client cap
//   is already tight. If we ever expose this without that cache, add
//   `RateLimitPolicies.presignByUser` (the closest existing per-user
//   policy that already gates R2-bound work) and wire a `rateLimit` field
//   below.
// * `last_used_at` is updated INSIDE the request (not via a background
//   trigger) so the dashboard's "last used X ago" indicator reflects the
//   real usage timestamp. We update it after listBuckets succeeds but
//   before returning — failure to write the timestamp is non-fatal and
//   does not roll back the response (see catch around the update).
// * Audit logging: success listings are NOT audited (high-volume read,
//   no security-relevant info — matches the GET /api/connections policy
//   in CLAUDE.md). Decryption failures ARE audited under
//   `security.decrypt_failed` because they signal either credential rot
//   at rest or a master-key mismatch — both worth investigating.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import {
  parseQuery,
  R2BucketsQuerySchema,
} from "@/lib/api/schemas";
import type { BucketSummary } from "@/lib/api/types";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { listBuckets } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type BucketsEnv = DbEnv & CryptoEnv;

/**
 * Normalize a blob column to Uint8Array. Drizzle's `blob({ mode: "buffer" })`
 * returns a Node Buffer locally but an ArrayBuffer under D1; Web Crypto needs
 * a real Uint8Array. Identical helper to `app/api/r2/presign/route.ts` — if
 * a third route needs this, lift it into `lib/db/blob.ts` rather than copying.
 */
function asU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(
    "buckets: stored credential blob is neither Uint8Array nor ArrayBuffer",
  );
}

export const GET = withApi(async (req, ctx) => {
  const input = await parseQuery(req, R2BucketsQuerySchema);
  const env = getRequestContext().env as unknown as BucketsEnv;
  const db = getDb(env);

  // Look up the connection scoped to the authenticated user. We MUST
  // include user_id in the WHERE clause — selecting by id alone would let
  // user A enumerate user B's buckets by guessing a ULID.
  const connection = await db
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, input.cid),
        eq(schema.connections.userId, ctx.userId),
      ),
    )
    .get();
  if (!connection) {
    // 404 (not 403) deliberately: we don't disclose whether a connection
    // exists under another user (prevents enumeration of cid ULIDs). Same
    // pattern as the presign route.
    throw ApiErrors.notFound("Connection not found");
  }

  // Decrypt both halves in parallel. AAD = connection.id binds each
  // ciphertext to its row — a ciphertext copied into another row would
  // fail GCM tag verification and throw CryptoIntegrityError.
  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    [accessKeyId, secretAccessKey] = await Promise.all([
      decryptCredential(
        asU8(connection.accessKeyCiphertext),
        asU8(connection.accessKeyIv),
        connection.id,
        env,
      ),
      decryptCredential(
        asU8(connection.secretKeyCiphertext),
        asU8(connection.secretKeyIv),
        connection.id,
        env,
      ),
    ]);
  } catch (err) {
    // Distinct from "R2 rejected the signature" — record under its own op
    // so the audit table makes the difference greppable. Generic 500 — we
    // never leak the inner CryptoIntegrityError detail to the client.
    await logAudit({
      userId: ctx.userId,
      connectionId: connection.id,
      op: "security.decrypt_failed",
      status: "failure",
      errorMsg:
        err instanceof CryptoIntegrityError
          ? "credential integrity check failed"
          : "credential decrypt failed",
      req,
    });
    throw ApiErrors.internal("Failed to decrypt connection credentials");
  }

  const client = makeS3Client({
    accountId: connection.accountId,
    accessKeyId,
    secretAccessKey,
  });

  let raw: Awaited<ReturnType<typeof listBuckets>>;
  try {
    raw = await listBuckets({ client });
  } catch (err) {
    if (err instanceof R2CredentialError) {
      // The user's R2 keys (not OUR session) are wrong/expired — surface
      // a 401 so the client can prompt for re-entry. Same convention as
      // the presign route documented in lib/r2/errors.ts.
      throw ApiErrors.unauthorized("R2 credentials rejected");
    }
    throw err;
  }

  // Normalize to the wire shape. R2 always returns a Name in practice but
  // the SDK types it as optional, so we filter rather than emit empty
  // strings. CreationDate maps to epoch ms or null — Date → number keeps
  // the JSON stable across runtimes.
  const buckets: BucketSummary[] = [];
  for (const b of raw) {
    if (typeof b.name !== "string" || b.name.length === 0) continue;
    buckets.push({
      name: b.name,
      createdAt: b.creationDate ? b.creationDate.getTime() : null,
    });
  }

  // Touch last_used_at so the connections table can show "used Xm ago".
  // Wrapped in try/catch because a failure to write the timestamp is non-
  // fatal to the user-facing request — the data is back already, we're
  // just losing one telemetry datum if the write fails.
  try {
    await db
      .update(schema.connections)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(schema.connections.id, connection.id),
          eq(schema.connections.userId, ctx.userId),
        ),
      )
      .run();
  } catch (err) {
    console.error(
      `[buckets ${ctx.requestId}] last_used_at update failed for cid=${connection.id}`,
      err,
    );
  }

  return buckets;
});
