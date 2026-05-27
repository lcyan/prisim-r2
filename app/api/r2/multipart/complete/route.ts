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
//   * Connection lookup + AES-GCM decrypt + S3Client live in
//     resolveConnectionForR2; the upload.complete success/failure audit is
//     delegated to runR2WithAudit. Decrypt failure is still distinct from
//     an R2 rejection — it surfaces as `security.decrypt_failed` from the
//     helper, not `upload.complete`.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2MultipartCompleteSchema } from "@/lib/api/schemas";
import type { R2MultipartCompleteResponse } from "@/lib/api/types";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { completeMultipartUpload } from "@/lib/r2/control";
import { resolveConnectionForR2, runR2WithAudit } from "@/lib/r2/route-helpers";

type MultipartCompleteEnv = DbEnv & CryptoEnv;

export const POST = withApi<R2MultipartCompleteResponse>(
  async (req, ctx) => {
    const input = await parseJson(req, R2MultipartCompleteSchema);
    const env = getCloudflareContext().env as unknown as MultipartCompleteEnv;

    const { connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "multipart/complete",
      auditBucket: input.bucket,
      auditKey: input.key,
    });

    const result = await runR2WithAudit(
      () =>
        completeMultipartUpload({
          client,
          bucket: input.bucket,
          key: input.key,
          uploadId: input.uploadId,
          parts: input.parts,
        }),
      {
        userId: ctx.userId,
        connectionId: connection.id,
        op: "upload.complete",
        bucket: input.bucket,
        key: input.key,
        req,
        failureLabel: "completeMultipartUpload failed",
      },
    );

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
