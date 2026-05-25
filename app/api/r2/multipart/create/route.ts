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
//   * Connection lookup + AES-GCM decrypt + S3Client live in
//     resolveConnectionForR2 (lib/r2/route-helpers.ts).
//   * `upload.create` audit on both success and failure paths is delegated
//     to runR2WithAudit so the audit-before-throw ordering is uniform.
//   * Rate limit: write-aggregate only (600/min/user). There is no narrower
//     "multipart.create" cap because we already cap the per-part presign
//     calls at 60/min, which is the real throttle in practice.

import "server-only";

import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2MultipartCreateSchema } from "@/lib/api/schemas";
import type { R2MultipartCreateResponse } from "@/lib/api/types";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { createMultipartUpload } from "@/lib/r2/control";
import {
  resolveConnectionForR2,
  runR2WithAudit,
} from "@/lib/r2/route-helpers";

export const runtime = "edge";

type MultipartCreateEnv = DbEnv & CryptoEnv;

export const POST = withApi<R2MultipartCreateResponse>(
  async (req, ctx) => {
    const input = await parseJson(req, R2MultipartCreateSchema);
    const env = getRequestContext().env as unknown as MultipartCreateEnv;

    const { connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "multipart/create",
      auditBucket: input.bucket,
      auditKey: input.key,
    });

    const { uploadId } = await runR2WithAudit(
      () =>
        createMultipartUpload({
          client,
          bucket: input.bucket,
          key: input.key,
          contentType: input.contentType,
        }),
      {
        userId: ctx.userId,
        connectionId: connection.id,
        op: "upload.create",
        bucket: input.bucket,
        key: input.key,
        req,
        failureLabel: "createMultipartUpload failed",
      },
    );

    return { uploadId };
  },
  {
    // No narrower per-endpoint cap — the per-part presign limiter at
    // 60/min is the effective throttle. Write-aggregate (600/min/user)
    // keeps a runaway client from spamming Create.
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
