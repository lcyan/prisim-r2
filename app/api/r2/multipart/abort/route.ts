// app/api/r2/multipart/abort/route.ts
//
// POST /api/r2/multipart/abort — cancel an in-progress multipart upload.
// Returns 204 with no body. Two reasons callers hit this:
//   1. The user cancelled the upload mid-flight in the UI.
//   2. The browser failed enough per-part PUTs that the client gives up and
//      cleans up the uploadId so R2 doesn't store the partial parts.
//
// R2 / S3 keeps every uploaded part billable until either Complete or Abort
// runs, so this endpoint is part of the storage-cost story, not just UX.
//
// Notes worth knowing before touching this file:
//   * Same security pattern as the sibling routes (create / complete).
//     User-scoped lookup, AAD-bound AES-GCM decrypt, R2CredentialError → 401.
//   * 204 is hand-built: withApi auto-wraps any value into a 200 JSON, so
//     returning the bare Response is the way to get the right status. The
//     wrapper still tags `x-request-id` on the way out.
//   * No 4xx for "uploadId not found" — R2 returns NoSuchUpload for an
//     uploadId we don't recognize. That maps to R2UpstreamError → 500
//     today. We deliberately don't special-case it because the UI's abort
//     flow is fire-and-forget cleanup; surfacing a friendlier 404 here
//     would require widening the R2UpstreamError → ApiError mapping for a
//     case nobody currently retries on.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2MultipartAbortSchema } from "@/lib/api/schemas";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { abortMultipartUpload } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type MultipartAbortEnv = DbEnv & CryptoEnv;

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2MultipartAbortSchema);
    const env = getRequestContext().env as unknown as MultipartAbortEnv;
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
      throw ApiErrors.notFound("Connection not found");
    }

    let accessKeyId: string;
    let secretAccessKey: string;
    try {
      [accessKeyId, secretAccessKey] = await Promise.all([
        decryptCredential(
          asU8(connection.accessKeyCiphertext, "multipart/abort"),
          asU8(connection.accessKeyIv, "multipart/abort"),
          connection.id,
          env,
        ),
        decryptCredential(
          asU8(connection.secretKeyCiphertext, "multipart/abort"),
          asU8(connection.secretKeyIv, "multipart/abort"),
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

    try {
      await abortMultipartUpload({
        client,
        bucket: input.bucket,
        key: input.key,
        uploadId: input.uploadId,
      });
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "upload.abort",
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg:
          err instanceof Error ? err.name : "abortMultipartUpload failed",
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
      op: "upload.abort",
      bucket: input.bucket,
      key: input.key,
      status: "success",
      req,
    });

    // 204: handed back as a bare Response so withApi doesn't wrap it in a
    // 200 JSON envelope. The wrapper still injects x-request-id on the way
    // out, so callers can correlate this with the audit row above.
    return new Response(null, { status: 204 });
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
