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
//   * Connection lookup + AES-GCM decrypt + S3Client + audit live in
//     lib/r2/route-helpers.ts.
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

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2MultipartAbortSchema } from "@/lib/api/schemas";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { abortMultipartUpload } from "@/lib/r2/control";
import {
  resolveConnectionForR2,
  runR2WithAudit,
} from "@/lib/r2/route-helpers";


type MultipartAbortEnv = DbEnv & CryptoEnv;

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2MultipartAbortSchema);
    const env = getCloudflareContext().env as unknown as MultipartAbortEnv;

    const { connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "multipart/abort",
      auditBucket: input.bucket,
      auditKey: input.key,
    });

    await runR2WithAudit(
      () =>
        abortMultipartUpload({
          client,
          bucket: input.bucket,
          key: input.key,
          uploadId: input.uploadId,
        }),
      {
        userId: ctx.userId,
        connectionId: connection.id,
        op: "upload.abort",
        bucket: input.bucket,
        key: input.key,
        req,
        failureLabel: "abortMultipartUpload failed",
      },
    );

    // 204: handed back as a bare Response so withApi doesn't wrap it in a
    // 200 JSON envelope. The wrapper still injects x-request-id on the way
    // out, so callers can correlate this with the audit row above.
    return new Response(null, { status: 204 });
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
