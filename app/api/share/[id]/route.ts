// app/api/share/[id]/route.ts
//
// DELETE /api/share/[id] — drop the bookkeeping row for one share.
//
// Important caveat — this does NOT (and cannot) revoke the presigned URL
// at the protocol layer. Once minted, the URL stays usable until the
// upstream signature expiry. The UI surfaces this explicitly with a
// warning before the user clicks delete; this handler's job is to remove
// the row so it stops appearing in /api/share listings.
//
//   1. validate path param         → ShareIdParamSchema (Zod)
//   2. DELETE … WHERE id = ? AND user_id = ?  (returning the row)
//   3. 404 when nothing was deleted
//   4. audit share.delete success/failure
//
// Notes worth knowing before touching this file:
//
// * The DELETE … RETURNING gives us the bucket / object_key / connection_id
//   for the audit row without a separate SELECT round-trip. Drizzle's
//   .returning() on D1 returns at most one row when WHERE matches exactly
//   one PK, so we can read it like a single-row result.
// * Scope by user_id in the WHERE clause — same enumeration-defense
//   pattern as every other route. A guessed ULID belonging to another
//   user's share returns 404, not 403, to avoid disclosing existence.
// * No protocol-layer revoke means a stolen URL is a real risk for the
//   chosen TTL. We do NOT try to invalidate the signature — R2 has no
//   "revoke presigned URL" primitive without rotating the access key,
//   which would break every other working presign for the same connection.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { ShareIdParamSchema } from "@/lib/api/schemas";
import type { ShareDeleteResponse } from "@/lib/api/types";
import { pathSegmentFromEnd } from "@/lib/api/path-id";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type ShareDeleteEnv = DbEnv;

export const DELETE = withApi(
  async (req, ctx) => {
    const id = pathSegmentFromEnd(req.url, 0);
    ShareIdParamSchema.parse({ id });

    const env = getCloudflareContext().env as unknown as ShareDeleteEnv;
    const db = getDb(env);

    // Single DELETE … RETURNING — atomic. The .returning() projection
    // mirrors what the audit row needs; we do NOT need to read url_hash
    // (it's a server-only fingerprint, never user-facing).
    const removed = await db
      .delete(schema.shares)
      .where(
        and(
          eq(schema.shares.id, id),
          eq(schema.shares.userId, ctx.userId),
        ),
      )
      .returning({
        id: schema.shares.id,
        connectionId: schema.shares.connectionId,
        bucket: schema.shares.bucket,
        objectKey: schema.shares.objectKey,
      })
      .all();

    const row = removed[0];
    if (!row) {
      await logAudit({
        userId: ctx.userId,
        connectionId: null,
        op: "share.delete",
        status: "failure",
        errorMsg: "not_found",
        req,
      });
      // 404 — never disclose that an id exists under another user.
      throw ApiErrors.notFound("Share not found");
    }

    await logAudit({
      userId: ctx.userId,
      connectionId: row.connectionId,
      op: "share.delete",
      bucket: row.bucket,
      key: row.objectKey,
      status: "success",
      req,
    });

    const body: ShareDeleteResponse = { ok: true, id: row.id };
    return body;
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
