// app/api/r2/multipart/complete/route.ts
//
// POST /api/r2/multipart/complete — finalize an in-progress multipart upload
// by handing R2 the ordered (partNumber, etag) list. Returns { etag, location }
// describing the newly-assembled object.
//
// Why we make this call (and not the browser directly): CompleteMultipartUpload
// embeds the full part list in the request body and is signed with the user's
// R2 keys. Doing it server-side keeps decrypted keys out of the browser and
// lets us log a single upload.complete audit row tied to the connection.
//
// Notes worth knowing before touching this file:
//   * `parts.sort` happens in lib/r2/control.completeMultipartUpload — we do
//     NOT pre-sort here. The control wrapper owns the contract with S3
//     (which returns InvalidPartOrder for an unsorted list), so sorting at
//     the route layer would be redundant + would let a future bug at the
//     route layer regress to "we accidentally re-introduced unsorted parts
//     because the control wrapper got refactored away".
//   * Zod already enforces parts.length >= 1 — see R2MultipartCompleteSchema.
//     The control wrapper double-checks this; the route does not.
//   * Same security-event split as the create route: decrypt failure is
//     `security.decrypt_failed`; an upstream R2 failure (including a stale
//     uploadId from a prior abort) audits as `upload.complete` + failure.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2MultipartCompleteSchema } from "@/lib/api/schemas";
import type { R2MultipartCompleteResponse } from "@/lib/api/types";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { completeMultipartUpload } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type MultipartCompleteEnv = DbEnv & CryptoEnv;

export const POST = withApi<R2MultipartCompleteResponse>(
  async (req, ctx) => {
    const input = await parseJson(req, R2MultipartCompleteSchema);
    const env = getRequestContext().env as unknown as MultipartCompleteEnv;
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
          asU8(connection.accessKeyCiphertext, "multipart/complete"),
          asU8(connection.accessKeyIv, "multipart/complete"),
          connection.id,
          env,
        ),
        decryptCredential(
          asU8(connection.secretKeyCiphertext, "multipart/complete"),
          asU8(connection.secretKeyIv, "multipart/complete"),
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

    let result: Awaited<ReturnType<typeof completeMultipartUpload>>;
    try {
      result = await completeMultipartUpload({
        client,
        bucket: input.bucket,
        key: input.key,
        uploadId: input.uploadId,
        parts: input.parts,
      });
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "upload.complete",
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg:
          err instanceof Error ? err.name : "completeMultipartUpload failed",
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
      op: "upload.complete",
      bucket: input.bucket,
      key: input.key,
      status: "success",
      req,
    });

    // Normalize optional fields to `null` so the wire shape is stable across
    // SDK versions (the SDK types both as optional even though R2 reliably
    // returns them on success).
    return {
      etag: result.etag ?? null,
      location: result.location ?? null,
    };
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
