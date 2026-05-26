// app/api/r2/presign/route.ts
//
// POST /api/r2/presign — mint a short-lived presigned URL the browser uses
// to talk directly to R2 (CLAUDE.md security invariant #3: our worker MUST
// NOT proxy object bytes). The handler does the minimum work to bridge "our
// authenticated user" → "R2 SigV4 signature":
//
//   1. validate input              → R2PresignSchema (Zod discriminated by op)
//   2. resolve connection          → user-scoped row + AAD-bound decrypt
//                                    (lib/r2/route-helpers.ts)
//   3. mint URL                    → presignPut / presignGet / presignUploadPart
//   4. audit + return              → { url, expiresAt }
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
// * Decryption failure is `security.decrypt_failed` + 500 inside the
//   resolveConnectionForR2 helper — kept distinct from "R2 rejected the
//   signature" so the audit table makes the difference greppable.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import {
  parseJson,
  R2PresignSchema,
  R2_PRESIGN_DEFAULT_TTL_SECONDS,
} from "@/lib/api/schemas";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import {
  presignGet,
  presignPut,
  presignUploadPart,
} from "@/lib/r2/presign";
import {
  resolveConnectionForR2,
  runR2WithAudit,
} from "@/lib/r2/route-helpers";
import type { AuditOp } from "@/lib/audit/log";

// Combined env shape — DB binding (for connection lookup + audit insert) +
// ENCRYPTION_KEY (for credential decrypt). Composed here rather than in
// lib/db|crypto because those modules each declare the minimal subset they
// need; the route layer is the one place that touches both.
type PresignEnv = DbEnv & CryptoEnv;

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2PresignSchema);
    const ttl = input.ttl ?? R2_PRESIGN_DEFAULT_TTL_SECONDS;
    const env = getCloudflareContext().env as unknown as PresignEnv;

    const { connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "presign",
      auditBucket: input.bucket,
      auditKey: input.key,
    });

    // upload-part is a write semantically (it uploads object bytes) so it
    // shares the `presign.put` audit code with the single-shot PUT —
    // keeping the audit codebook narrow (one per direction).
    const op: AuditOp = input.op === "get" ? "presign.get" : "presign.put";

    const url = await runR2WithAudit(
      () => {
        switch (input.op) {
          case "put":
            return presignPut({
              client,
              bucket: input.bucket,
              key: input.key,
              ttl,
            });
          case "get":
            return presignGet({
              client,
              bucket: input.bucket,
              key: input.key,
              ttl,
            });
          case "upload-part":
            return presignUploadPart({
              client,
              bucket: input.bucket,
              key: input.key,
              uploadId: input.uploadId,
              partNumber: input.partNumber,
              ttl,
            });
        }
      },
      {
        userId: ctx.userId,
        connectionId: connection.id,
        op,
        bucket: input.bucket,
        key: input.key,
        req,
        failureLabel: "presign failed",
      },
    );

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
