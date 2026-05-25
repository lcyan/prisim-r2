// lib/r2/route-helpers.ts
//
// Shared scaffolding for the R2 route handlers. Every R2-touching route
// (buckets / list / presign / delete / multipart {create,complete,abort} /
// share {create,reveal} / dashboard summary) runs the same security ritual:
//
//   1. SELECT … WHERE id = ? AND user_id = ?      — enumeration defense
//   2. AAD-bound AES-GCM decrypt of both credentials  — CLAUDE.md invariant #1
//   3. logAudit(security.decrypt_failed) on throw  — distinct from R2 errors
//   4. build an S3Client for the route to use
//
// Lifting these into one place keeps the security invariants central — a
// regression that drops the user-scoping or AAD binding fails one test, not
// ten. Routes call `resolveConnectionForR2` and get a ready-to-use S3Client
// back; the only callsite-specific knob is the `purpose` string that goes
// into asU8 messages and the optional audit bucket/key.
//
// `runR2WithAudit` then handles the next-most-repeated ritual: wrap one R2
// SDK call so success/failure audit rows are written either way, and
// R2CredentialError is mapped to 401. Don't migrate routes whose failure
// audit has bespoke shape (e.g. delete/route.ts's "<N> key(s)" message);
// those are listed in the route file comments.
//
// `touchConnectionLastUsed` is the non-fatal `connections.last_used_at`
// update — same try/catch/console.error in two list-style routes.

import "server-only";

import { and, eq } from "drizzle-orm";
import type { S3Client } from "@aws-sdk/client-s3";

import { ApiErrors } from "@/lib/api/errors";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type Db, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit, type AuditOp } from "@/lib/audit/log";

export interface ResolveConnectionForR2Input {
  /** Connection ULID. Aliased per-route as `cid` or `connectionId`; this
   *  helper just calls it `cid`. */
  cid: string;
  userId: string;
  env: DbEnv & CryptoEnv;
  req: Request;
  /** Tag passed into asU8 messages — appears in error logs as the route
   *  that was decrypting (e.g. "buckets", "list", "presign"). */
  purpose: string;
  /** Audit fields for the security.decrypt_failed row. Omit when the route
   *  doesn't carry a bucket/key in the request (buckets, dashboard summary). */
  auditBucket?: string | null;
  auditKey?: string | null;
}

export interface ResolvedR2Connection {
  db: Db;
  connection: typeof schema.connections.$inferSelect;
  client: S3Client;
}

/**
 * Look up the user-scoped connection, decrypt both credentials in parallel
 * with AAD = connection.id, and return a ready-to-use S3Client. Throws
 * `ApiErrors.notFound` on missing row (no audit — the row simply doesn't
 * exist for this user) and `ApiErrors.internal` on decrypt failure (with
 * the `security.decrypt_failed` audit row already flushed).
 *
 * Security invariants enforced here (do NOT relax in routes):
 *   * WHERE clause MUST include `userId` — a guessed ULID belonging to
 *     another user must surface as 404, not silently decrypt their creds.
 *   * AAD MUST be `connection.id` — a ciphertext copied between rows fails
 *     the GCM tag check and is caught by the catch arm.
 *   * Decrypt failure MUST audit before the 500 throw.
 */
export async function resolveConnectionForR2(
  input: ResolveConnectionForR2Input,
): Promise<ResolvedR2Connection> {
  const db = getDb(input.env);

  const connection = await db
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, input.cid),
        eq(schema.connections.userId, input.userId),
      ),
    )
    .get();
  if (!connection) {
    // 404 not 403: don't disclose whether a cid exists under another user.
    throw ApiErrors.notFound("Connection not found");
  }

  let accessKeyId: string;
  let secretAccessKey: string;
  try {
    [accessKeyId, secretAccessKey] = await Promise.all([
      decryptCredential(
        asU8(connection.accessKeyCiphertext, input.purpose),
        asU8(connection.accessKeyIv, input.purpose),
        connection.id,
        input.env,
      ),
      decryptCredential(
        asU8(connection.secretKeyCiphertext, input.purpose),
        asU8(connection.secretKeyIv, input.purpose),
        connection.id,
        input.env,
      ),
    ]);
  } catch (err) {
    await logAudit({
      userId: input.userId,
      connectionId: connection.id,
      op: "security.decrypt_failed",
      bucket: input.auditBucket ?? null,
      key: input.auditKey ?? null,
      status: "failure",
      errorMsg:
        err instanceof CryptoIntegrityError
          ? "credential integrity check failed"
          : "credential decrypt failed",
      req: input.req,
    });
    throw ApiErrors.internal("Failed to decrypt connection credentials");
  }

  const client = makeS3Client({
    accountId: connection.accountId,
    accessKeyId,
    secretAccessKey,
  });

  return { db, connection, client };
}

export interface R2AuditContext {
  userId: string;
  connectionId: string;
  op: AuditOp;
  bucket?: string | null;
  key?: string | null;
  req: Request;
  /** Fallback errorMsg when the thrown value isn't an Error (e.g. a raw
   *  string from a non-SDK path). Concrete Error instances surface as
   *  `err.name`, matching the previous per-route shape. */
  failureLabel: string;
}

/**
 * Wrap one R2 SDK call so success and failure both get audited and
 * `R2CredentialError` is mapped to 401. Audit row is awaited (not fire-
 * and-forget) so it's flushed before the Pages worker spins down.
 *
 * Don't use this in routes whose failure audit has a bespoke shape:
 *   * delete/route.ts — errorMsg encodes the requested key count
 *   * share/create/route.ts — has an extra "INSERT failed" audit after
 *     presign succeeds
 */
export async function runR2WithAudit<T>(
  fn: () => Promise<T>,
  audit: R2AuditContext,
): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await logAudit({
      userId: audit.userId,
      connectionId: audit.connectionId,
      op: audit.op,
      bucket: audit.bucket ?? null,
      key: audit.key ?? null,
      status: "failure",
      errorMsg: err instanceof Error ? err.name : audit.failureLabel,
      req: audit.req,
    });
    if (err instanceof R2CredentialError) {
      throw ApiErrors.unauthorized("R2 credentials rejected");
    }
    throw err;
  }

  await logAudit({
    userId: audit.userId,
    connectionId: audit.connectionId,
    op: audit.op,
    bucket: audit.bucket ?? null,
    key: audit.key ?? null,
    status: "success",
    req: audit.req,
  });
  return result;
}

/**
 * Best-effort `connections.last_used_at` touch. Never throws — telemetry
 * only. The request body is already prepared by the time this runs and we
 * never want a failed timestamp write to kill the user-facing response.
 *
 * Scoped by (id, userId) so a leaked or guessed ULID still can't update
 * another user's row.
 */
export async function touchConnectionLastUsed(
  db: Db,
  args: {
    connectionId: string;
    userId: string;
    requestId: string;
    /** Route name, surfaced in console.error so log greps know which route
     *  failed to touch the timestamp. */
    tag: string;
  },
): Promise<void> {
  try {
    await db
      .update(schema.connections)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(schema.connections.id, args.connectionId),
          eq(schema.connections.userId, args.userId),
        ),
      )
      .run();
  } catch (err) {
    console.error(
      `[${args.tag} ${args.requestId}] last_used_at update failed for cid=${args.connectionId}`,
      err,
    );
  }
}
