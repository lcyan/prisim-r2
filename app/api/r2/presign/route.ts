// app/api/r2/presign/route.ts
//
// POST /api/r2/presign — mint a short-lived presigned URL the browser uses
// to talk directly to R2 (CLAUDE.md security invariant #3: our worker MUST
// NOT proxy object bytes). The handler does the minimum work to bridge "our
// authenticated user" → "R2 SigV4 signature":
//
//   1. validate input              → R2PresignSchema (Zod discriminated by op)
//   2. fetch & user-scope the row  → connections.id = cid AND userId = ctx
//   3. decrypt access/secret keys  → AES-GCM with AAD = connection.id
//   4. mint URL                    → presignPut / presignGet / presignUploadPart
//   5. audit + return              → { url, expiresAt }
//
// Notes worth knowing before touching this file:
//
// * The URL is NEVER persisted (security invariant + task brief). It only
//   lives in the JSON response and the browser's memory. audit_log records
//   that a presign happened, not the URL itself.
// * `upload-part` is logged as `presign.put` (it's a write op semantically),
//   matching the AuditOp union in lib/audit/log.ts.
// * Rate limiting + CSRF + session checks happen in withApi BEFORE this
//   function runs. A request that lands here is already authenticated and
//   below the 60/min/user presign cap.
// * Decryption failure is a "credentials at rest are corrupted or master
//   key rotated" event → security.decrypt_failed audit + 500. We don't
//   leak the underlying CryptoIntegrityError detail to the client.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import {
  parseJson,
  R2PresignSchema,
  R2_PRESIGN_DEFAULT_TTL_SECONDS,
  type R2PresignInput,
} from "@/lib/api/schemas";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import {
  presignGet,
  presignPut,
  presignUploadPart,
} from "@/lib/r2/presign";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit, type AuditOp } from "@/lib/audit/log";

// Edge runtime is mandatory on Pages for routes touching D1 / getRequestContext.
export const runtime = "edge";

// Combined env shape — DB binding (for connection lookup + audit insert) +
// ENCRYPTION_KEY (for credential decrypt). Composed here rather than in
// lib/db|crypto because those modules each declare the minimal subset they
// need; the route layer is the one place that touches both.
type PresignEnv = DbEnv & CryptoEnv;

/**
 * Resolve the audit op for a presign call. upload-part is a write semantically
 * (it uploads object bytes) so it shares the `presign.put` audit code with
 * the single-shot PUT — keeping the audit codebook narrow (one per direction).
 */
function auditOpFor(op: R2PresignInput["op"]): AuditOp {
  return op === "get" ? "presign.get" : "presign.put";
}

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2PresignSchema);
    const ttl = input.ttl ?? R2_PRESIGN_DEFAULT_TTL_SECONDS;
    const env = getRequestContext().env as unknown as PresignEnv;
    const db = getDb(env);

    // Look up the connection scoped to the authenticated user. We MUST
    // include user_id in the WHERE clause — selecting by id alone would let
    // user A presign objects with user B's credentials by guessing a ULID.
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
      // exists under another user, which prevents enumeration of cid ULIDs.
      throw ApiErrors.notFound("Connection not found");
    }

    // Decrypt both credentials in parallel. AAD = connection.id binds each
    // ciphertext to its row — a ciphertext copied into another row will
    // fail GCM tag verification and throw CryptoIntegrityError.
    let accessKeyId: string;
    let secretAccessKey: string;
    try {
      [accessKeyId, secretAccessKey] = await Promise.all([
        decryptCredential(
          asU8(connection.accessKeyCiphertext, "presign"),
          asU8(connection.accessKeyIv, "presign"),
          connection.id,
          env,
        ),
        decryptCredential(
          asU8(connection.secretKeyCiphertext, "presign"),
          asU8(connection.secretKeyIv, "presign"),
          connection.id,
          env,
        ),
      ]);
    } catch (err) {
      // Decrypt failure is a security event distinct from "R2 rejected the
      // signature" — record it under its own op so the audit table makes
      // the difference greppable.
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "security.decrypt_failed",
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg:
          err instanceof CryptoIntegrityError
            ? "credential integrity check failed"
            : "credential decrypt failed",
        req,
      });
      // Generic 500 — never surface the inner crypto error to the client.
      throw ApiErrors.internal("Failed to decrypt connection credentials");
    }

    const client = makeS3Client({
      accountId: connection.accountId,
      accessKeyId,
      secretAccessKey,
    });

    const op = auditOpFor(input.op);
    let url: string;
    try {
      switch (input.op) {
        case "put":
          url = await presignPut({
            client,
            bucket: input.bucket,
            key: input.key,
            ttl,
          });
          break;
        case "get":
          url = await presignGet({
            client,
            bucket: input.bucket,
            key: input.key,
            ttl,
          });
          break;
        case "upload-part":
          url = await presignUploadPart({
            client,
            bucket: input.bucket,
            key: input.key,
            uploadId: input.uploadId,
            partNumber: input.partNumber,
            ttl,
          });
          break;
      }
    } catch (err) {
      // Audit the attempt before re-mapping the error so we always have a
      // row for "user X tried to presign Y at time Z and it failed".
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op,
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg: err instanceof Error ? err.name : "presign failed",
        req,
      });
      if (err instanceof R2CredentialError) {
        // The user's R2 keys (not OUR session) are wrong/expired — surface
        // a 401 so the client can prompt for re-entry, exactly like the
        // route-level pattern documented in lib/r2/errors.ts.
        throw ApiErrors.unauthorized("R2 credentials rejected");
      }
      throw err;
    }

    // Single happy-path audit row. `await` (rather than fire-and-forget) is
    // intentional — the Pages worker can spin down its event loop the moment
    // we return, and we want this insert flushed first.
    await logAudit({
      userId: ctx.userId,
      connectionId: connection.id,
      op,
      bucket: input.bucket,
      key: input.key,
      status: "success",
      req,
    });

    return {
      url,
      // ms epoch, matching the task brief. Plain Date.now() math keeps the
      // client free of any TZ assumptions — it just compares against its own
      // clock when deciding to refresh.
      expiresAt: Date.now() + ttl * 1000,
    };
  },
  {
    // Order matters (see lib/api/rate-limit.ts comment): per-endpoint cap
    // first so the 61st presign trips presign:user:* rather than the broader
    // write-aggregate budget — much more actionable error for the client.
    rateLimit: ({ ctx }) => RateLimitBundles.presignByUser(ctx.userId),
  },
);
