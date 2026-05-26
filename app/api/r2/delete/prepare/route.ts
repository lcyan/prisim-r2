// app/api/r2/delete/prepare/route.ts
//
// POST /api/r2/delete/prepare — first leg of the two-step destructive
// delete flow. CLAUDE.md security invariant #4 requires every destructive
// operation to carry a server-verified confirmation token; this route mints
// the token, the sibling /api/r2/delete route consumes it.
//
//   1. validate input             → R2DeletePrepareSchema (Zod)
//   2. user-scope the connection  → cid AND userId
//   3. mint HMAC token            → issueDeleteToken (lib/api/delete-token)
//   4. return { confirmToken, expiresAt }
//
// Notes worth knowing before touching this file:
//
// * No R2 round-trip here — the route never decrypts credentials or talks
//   to R2. The token binds `(userId, bucket, sha256(sort(keys)))` only;
//   actual deletion happens at /api/r2/delete after the typed-confirmation
//   ceremony on the client. Skipping the decrypt+R2 hop keeps the prepare
//   path cheap and avoids leaving open API quota footprints when the user
//   abandons the dialog.
// * Connection lookup is still scoped by user_id (not "skip the check —
//   we'll do it in the confirm step"). A 404 here tells the UI to bail
//   before opening the dialog at all, and stops cross-user cid probing.
// * No audit row on prepare alone. The intent has not yet been acted on —
//   audit fires in the confirm route, both for success and failure. Pairing
//   the audit with the irreversible action keeps the table aligned with
//   "things that happened to objects", not "things the user clicked".
// * Rate-limited under the write-aggregate budget. A burst of prepare
//   requests is the cheap way to enumerate connections via timing; the
//   600/min cap is plenty for legitimate UI use and starves abuse.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, R2DeletePrepareSchema } from "@/lib/api/schemas";
import type { R2DeletePrepareResponse } from "@/lib/api/types";
import {
  issueDeleteToken,
  type DeleteTokenEnv,
} from "@/lib/api/delete-token";
import { getDb, schema, type DbEnv } from "@/lib/db/client";

export const runtime = "edge";

// AUTH_SECRET is read by the token helper for HMAC; DB binding is used
// only for the user-scoped connection existence check. We do NOT touch
// the ENCRYPTION_KEY here — no credential decrypt happens on this path.
type PrepareEnv = DbEnv & DeleteTokenEnv;

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, R2DeletePrepareSchema);
    const env = getCloudflareContext().env as unknown as PrepareEnv;
    const db = getDb(env);

    // Scope by user_id — selecting on cid alone would let user A probe
    // whether user B has connection X by inspecting 404 vs 200 latency.
    // Same pattern as the other R2 routes; select only id (not the full
    // row) since we don't need the credential blobs at this step.
    const connection = await db
      .select({ id: schema.connections.id })
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

    const { token, expiresAt } = await issueDeleteToken({
      userId: ctx.userId,
      bucket: input.bucket,
      keys: input.keys,
      env,
    });

    const body: R2DeletePrepareResponse = {
      confirmToken: token,
      expiresAt,
    };
    return body;
  },
  {
    // Prepare is cheap (no decrypt, no R2 call) but it's still a write-flow
    // entry point — count it against the 600/min user write budget so a
    // misbehaving client can't fire prepare in a loop to probe connection
    // ULIDs.
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
