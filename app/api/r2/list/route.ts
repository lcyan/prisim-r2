// app/api/r2/list/route.ts
//
// GET /api/r2/list?cid=<ULID>&bucket=<name>&prefix=<str>&cursor=<opaque>
//
// Folder-style listing for the file browser. The handler:
//
//   1. validate query             → R2ListQuerySchema (Zod)
//   2. fetch & user-scope the row → connections.id = cid AND user_id = ctx
//   3. decrypt access/secret keys → AES-GCM with AAD = connection.id
//   4. listObjects via R2 SDK     → Delimiter='/' to fold deeper keys
//                                   into CommonPrefixes (folder listing)
//   5. update last_used_at        → fire-and-forget after the body lands
//   6. return R2ListResponse
//
// Notes worth knowing before touching this file:
//
// * Same pattern + same trade-offs as the buckets route (see comments
//   there). GET is exempt from CSRF in withApi. No rate limit — the UI
//   sits behind TanStack Query's cache and the natural client cap is
//   already tight; one round-trip costs us one decrypt + one R2 hit,
//   not object bytes (CLAUDE.md security invariant #3).
// * No audit on success (high-volume read, matches GET /api/connections
//   + GET /api/r2/buckets policy). Decryption failures ARE audited under
//   `security.decrypt_failed` because they're a security event.
// * Page size is fixed server-side via R2_LIST_DEFAULT_MAX_KEYS (200) —
//   the client cannot override. This bounds per-request work regardless
//   of caller behavior. Pagination is cursor-based (NextContinuationToken)
//   not offset-based; the client surfaces `nextCursor` straight back into
//   the next request.
// * Empty bucket / empty page returns the stable shape
//     { objects: [], prefixes: [], nextCursor: null }
//   so consumers don't need to defensively `?? []` on every field.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import {
  parseQuery,
  R2ListQuerySchema,
  R2_LIST_DEFAULT_MAX_KEYS,
} from "@/lib/api/schemas";
import type { R2ListObject, R2ListResponse } from "@/lib/api/types";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { listObjects } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type ListEnv = DbEnv & CryptoEnv;

/**
 * Normalize a blob column to Uint8Array. Drizzle's `blob({ mode: "buffer" })`
 * returns a Node Buffer locally but an ArrayBuffer under D1; Web Crypto needs
 * a real Uint8Array. Identical helper to `app/api/r2/buckets/route.ts` and
 * `app/api/r2/presign/route.ts` — if a fourth route needs this, lift it
 * into `lib/db/blob.ts` rather than copying.
 */
function asU8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(
    "list: stored credential blob is neither Uint8Array nor ArrayBuffer",
  );
}

export const GET = withApi(async (req, ctx) => {
  const input = await parseQuery(req, R2ListQuerySchema);
  const env = getRequestContext().env as unknown as ListEnv;
  const db = getDb(env);

  // Scope by user_id — selecting on cid alone would let user A enumerate
  // user B's buckets/objects by guessing a ULID. Same pattern as buckets
  // and presign routes.
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
    // exists under another user — prevents enumeration of cid ULIDs.
    throw ApiErrors.notFound("Connection not found");
  }

  // Decrypt both halves in parallel. AAD = connection.id binds each
  // ciphertext to its row.
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
    await logAudit({
      userId: ctx.userId,
      connectionId: connection.id,
      op: "security.decrypt_failed",
      bucket: input.bucket,
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

  let raw: Awaited<ReturnType<typeof listObjects>>;
  try {
    raw = await listObjects({
      client,
      bucket: input.bucket,
      prefix: input.prefix,
      // Folder-style listing — fold every key past the next "/" into
      // CommonPrefixes. Hardcoded "/" rather than parameterized: the
      // entire UI assumes the slash convention, and exposing a custom
      // delimiter would surprise the file browser more than it helps.
      delimiter: "/",
      continuationToken: input.cursor,
      maxKeys: R2_LIST_DEFAULT_MAX_KEYS,
    });
  } catch (err) {
    if (err instanceof R2CredentialError) {
      // The user's R2 keys (not OUR session) are wrong/expired — surface
      // a 401 so the client can prompt for re-entry. Same convention as
      // buckets / presign routes.
      throw ApiErrors.unauthorized("R2 credentials rejected");
    }
    throw err;
  }

  // Normalize SDK shapes (optional fields → null) so the wire payload is
  // stable across SDK versions and easy to consume from the browser.
  const objects: R2ListObject[] = raw.items.map((item) => ({
    key: item.key,
    size: typeof item.size === "number" ? item.size : null,
    etag: typeof item.etag === "string" ? item.etag : null,
    lastModified:
      item.lastModified instanceof Date ? item.lastModified.getTime() : null,
  }));

  const body: R2ListResponse = {
    objects,
    prefixes: raw.prefixes,
    // Coerce undefined → null so JSON consumers see an explicit "no more
    // pages" sentinel rather than the key being absent entirely.
    nextCursor: raw.continuationToken ?? null,
  };

  // Touch last_used_at — same rationale as the buckets route. Failure
  // is non-fatal; the body is already prepared and only telemetry is
  // lost if the write fails.
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
      `[list ${ctx.requestId}] last_used_at update failed for cid=${connection.id}`,
      err,
    );
  }

  return body;
});
