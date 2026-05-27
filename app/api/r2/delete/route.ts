// app/api/r2/delete/route.ts
//
// POST /api/r2/delete — second leg of the two-step destructive delete
// flow. The caller must have already obtained a confirmToken from
// /api/r2/delete/prepare for THE EXACT SAME (cid, bucket, keys[]) triple;
// any tamper or replay across triples fails HMAC verification.
//
//   1. validate input              → R2DeleteConfirmSchema (Zod)
//   2. verify confirmToken         → verifyDeleteToken (lib/api/delete-token)
//   3. resolve connection          → user-scoped row + AAD-bound decrypt
//                                    (lib/r2/route-helpers.ts)
//   4. deleteObjects               → batches at 1000 internally
//   5. audit + return              → object.delete success/failure
//
// Notes worth knowing before touching this file:
//
// * Token verification runs BEFORE connection lookup. A forged token is
//   far cheaper to reject than a DB query, and we don't want token-replay
//   attempts to consume D1 quota. The order also means a token issued for
//   a now-deleted connection still rejects on token check first (correct —
//   the intent is invalid regardless of why).
// * V1 is non-recursive. The UI only sends literal flat keys gathered
//   from row selection (CLAUDE.md "R2 list uses ContinuationToken"); the
//   schema's ObjectKeySchema already rejects empty or leading-slash keys.
// * Per-key audit vs one summarized row: we write ONE audit row per
//   delete request (op=object.delete) tagged with the batch's key count
//   in errorMsg when partial failures occur. Writing N rows for N keys
//   would multiply audit volume on bulk operations without adding
//   greppable signal — the failing key list lives in the response and
//   in R2's own per-bucket audit if the user enables it.
// * Partial-failure semantics: R2's DeleteObjects is partial — keys
//   that succeed are reported in Deleted, keys that don't in Errors,
//   and the HTTP call still returns 200. We surface both arrays
//   verbatim to the caller. Status of the audit row is "success" iff
//   errors is empty. THIS bespoke success/failure decision is why this
//   route doesn't use runR2WithAudit — a single audit row covers both
//   the success and partial-failure branches with a count payload.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2DeleteConfirmSchema } from "@/lib/api/schemas";
import type { R2DeleteResponse } from "@/lib/api/types";
import {
  DeleteTokenError,
  verifyDeleteToken,
  type DeleteTokenEnv,
} from "@/lib/api/delete-token";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { deleteObjects } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { resolveConnectionForR2 } from "@/lib/r2/route-helpers";
import { logAudit } from "@/lib/audit/log";

type DeleteEnv = DbEnv & CryptoEnv & DeleteTokenEnv;

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2DeleteConfirmSchema);
    const env = getCloudflareContext().env as unknown as DeleteEnv;

    // Verify the confirm token FIRST — before any DB query or decrypt.
    // The token binds (user, bucket, sort(keys)+sha256), so a forged or
    // replayed token never reaches the connection lookup or audit row.
    // Failures collapse to confirmation.required so the client surfaces
    // the same "confirm again" UX whether the token expired or was tampered.
    try {
      await verifyDeleteToken({
        token: input.confirmToken,
        userId: ctx.userId,
        bucket: input.bucket,
        keys: input.keys,
        env,
      });
    } catch (err) {
      if (err instanceof DeleteTokenError) {
        throw ApiErrors.confirmationRequired(
          "Confirmation token invalid or expired; re-confirm to delete",
        );
      }
      // Any other throw is a config error (missing AUTH_SECRET, etc.) —
      // bubble up as 500 rather than masquerade as confirmation failure.
      throw err;
    }

    const { connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "delete",
      auditBucket: input.bucket,
    });

    let result: Awaited<ReturnType<typeof deleteObjects>>;
    try {
      result = await deleteObjects({
        client,
        bucket: input.bucket,
        keys: input.keys,
      });
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "object.delete",
        bucket: input.bucket,
        // No single object_key for a multi-key request — leave null and
        // record the requested count in errorMsg so audit greps can spot
        // the batch.
        status: "failure",
        errorMsg:
          err instanceof Error
            ? `${err.name}: ${input.keys.length} key(s)`
            : `deleteObjects failed: ${input.keys.length} key(s)`,
        req,
      });
      if (err instanceof R2CredentialError) {
        throw ApiErrors.unauthorized("R2 credentials rejected");
      }
      throw err;
    }

    // Partial failure: status="failure" so audit grep can find the
    // operation even when the HTTP response is 200. errorMsg carries the
    // counts so an operator can size up the blast radius without
    // pulling the full response from logs.
    const fullySucceeded = result.errors.length === 0;
    await logAudit({
      userId: ctx.userId,
      connectionId: connection.id,
      op: "object.delete",
      bucket: input.bucket,
      status: fullySucceeded ? "success" : "failure",
      errorMsg: fullySucceeded
        ? `${result.deleted.length} key(s) deleted`
        : `${result.deleted.length} deleted, ${result.errors.length} failed`,
      req,
    });

    const body: R2DeleteResponse = {
      deleted: result.deleted,
      errors: result.errors,
    };
    return body;
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
