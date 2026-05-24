// app/api/r2/multipart/create/route.ts
//
// POST /api/r2/multipart/create — start a multipart upload on R2 and return
// the uploadId the browser then carries into per-part presign calls. This
// is the control-plane half of the large-file upload path:
//
//   browser → POST /api/r2/multipart/create     ← us, this file
//   browser → POST /api/r2/presign (op=upload-part)  per chunk × N
//   browser → PUT  <signed url>                  direct to R2 (bytes)
//   browser → POST /api/r2/multipart/complete    ← us, sibling file
//
// Why we make this call (and not the browser directly): CreateMultipartUpload
// requires a SigV4 signature, and a pre-signed CreateMultipartUpload URL is
// awkward (S3 signs the `?uploads` query string differently across SDK
// versions). Doing it server-side keeps the browser holding only short-lived
// per-part URLs while we keep the upload-level metadata in our worker for
// exactly one call.
//
// Notes that mirror the presign route (read those first if you haven't):
//   * User-scoped connection lookup: connections.id = cid AND user_id = ctx.
//     Selecting on cid alone would let user A start an upload under user B's
//     credentials by guessing a ULID.
//   * AES-GCM decrypt with AAD = connection.id — see lib/crypto/aes-gcm.ts.
//     A ciphertext copied into another row fails the tag check.
//   * Audit `upload.create` on both success and failure paths. Awaited so
//     the row is flushed before Pages spins down the worker.
//   * Rate limit: write-aggregate only (600/min/user). There is no narrower
//     "multipart.create" cap because we already cap the per-part presign
//     calls at 60/min, which is the real throttle in practice.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2MultipartCreateSchema } from "@/lib/api/schemas";
import type { R2MultipartCreateResponse } from "@/lib/api/types";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { createMultipartUpload } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type MultipartCreateEnv = DbEnv & CryptoEnv;

export const POST = withApi<R2MultipartCreateResponse>(
  async (req, ctx) => {
    const input = await parseJson(req, R2MultipartCreateSchema);
    const env = getRequestContext().env as unknown as MultipartCreateEnv;
    const db = getDb(env);

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
      // 404 not 403: don't disclose existence of another user's cid.
      throw ApiErrors.notFound("Connection not found");
    }

    let accessKeyId: string;
    let secretAccessKey: string;
    try {
      [accessKeyId, secretAccessKey] = await Promise.all([
        decryptCredential(
          asU8(connection.accessKeyCiphertext, "multipart/create"),
          asU8(connection.accessKeyIv, "multipart/create"),
          connection.id,
          env,
        ),
        decryptCredential(
          asU8(connection.secretKeyCiphertext, "multipart/create"),
          asU8(connection.secretKeyIv, "multipart/create"),
          connection.id,
          env,
        ),
      ]);
    } catch (err) {
      // Distinct security event vs. an R2 rejection — record it under its
      // own op so the audit table makes the difference greppable.
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
      throw ApiErrors.internal("Failed to decrypt connection credentials");
    }

    const client = makeS3Client({
      accountId: connection.accountId,
      accessKeyId,
      secretAccessKey,
    });

    let uploadId: string;
    try {
      const res = await createMultipartUpload({
        client,
        bucket: input.bucket,
        key: input.key,
        contentType: input.contentType,
      });
      uploadId = res.uploadId;
    } catch (err) {
      // Audit before mapping so we always have a row for this attempt.
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "upload.create",
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg: err instanceof Error ? err.name : "createMultipartUpload failed",
        req,
      });
      if (err instanceof R2CredentialError) {
        throw ApiErrors.unauthorized("R2 credentials rejected");
      }
      throw err;
    }

    await logAudit({
      userId: ctx.userId,
      connectionId: connection.id,
      op: "upload.create",
      bucket: input.bucket,
      key: input.key,
      status: "success",
      req,
    });

    return { uploadId };
  },
  {
    // No narrower per-endpoint cap — the per-part presign limiter at
    // 60/min is the effective throttle. Write-aggregate (600/min/user)
    // keeps a runaway client from spamming Create.
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
