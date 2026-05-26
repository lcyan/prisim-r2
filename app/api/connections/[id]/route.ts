// app/api/connections/[id]/route.ts
//
// PATCH + DELETE for a single connection record. Both routes:
//   * require an authenticated session + CSRF token (handled by withApi)
//   * are bounded by the user's write-aggregate rate-limit bundle
//   * scope every DB statement with `userId = ctx.userId` so a leaked or
//     guessed ULID still can't touch another user's row
//   * write to audit_log on every outcome (success and failure)
//
// What this file does NOT do:
//   * It does NOT allow re-keying a connection through PATCH. Rotating the
//     access/secret pair MUST go through POST /api/connections (which probes
//     R2 and re-encrypts). The strict PATCH schema enforces this — handler
//     never sees anything other than `{ name }`.
//   * It does NOT cascade-delete shares. Default product behavior is to
//     refuse with 409 connection.in_use and ask the user to delete shares
//     first. A future cascade option would land here behind a confirmation
//     token (CLAUDE.md security invariant #4).

import "server-only";

import { and, count, eq, gt } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import {
  parseJson,
  ConnectionIdParamSchema,
  ConnectionsPatchSchema,
} from "@/lib/api/schemas";
import { pathSegmentFromEnd } from "@/lib/api/path-id";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import { logAudit } from "@/lib/audit/log";
import type { ConnectionSummary } from "@/lib/api/types";

export const runtime = "edge";

type ConnectionsEnv = DbEnv;

/** Next.js 15 wraps dynamic route params in a Promise. We don't consume the
 *  params context directly because withApi narrows the handler signature to
 *  `(req) => Response`; instead we re-derive the id from req.url via
 *  pathSegmentFromEnd() (lib/api/path-id.ts). */

// ─── PATCH /api/connections/[id] — rename only ──────────────────────────

export const PATCH = withApi<ConnectionSummary>(
  async (req, ctx) => {
    // `req` carries no params in withApi's signature; Next 15 passes them
    // as the second argument to the original handler. We re-derive id by
    // peeking at the request URL — withApi doesn't intercept the second
    // arg, so we keep things simple by parsing it from the path.
    const id = pathSegmentFromEnd(req.url, 0);
    ConnectionIdParamSchema.parse({ id });

    const input = await parseJson(req, ConnectionsPatchSchema);
    const env = getCloudflareContext().env as unknown as ConnectionsEnv;
    const db = getDb(env);

    // Single statement: UPDATE … WHERE id = ? AND user_id = ? RETURNING …
    // Scoping by userId in the WHERE clause is what prevents user B from
    // renaming user A's connection by guessing the ULID.
    const updated = await db
      .update(schema.connections)
      .set({ name: input.name })
      .where(
        and(
          eq(schema.connections.id, id),
          eq(schema.connections.userId, ctx.userId),
        ),
      )
      .returning({
        id: schema.connections.id,
        name: schema.connections.name,
        accountId: schema.connections.accountId,
        accessKeyMasked: schema.connections.accessKeyMasked,
        createdAt: schema.connections.createdAt,
        lastUsedAt: schema.connections.lastUsedAt,
      })
      .all();

    const row = updated[0];
    if (!row) {
      // 404 (not 403) to mirror the presign route — never disclose whether
      // a connection exists under another user.
      await logAudit({
        userId: ctx.userId,
        connectionId: id,
        op: "connection.update",
        status: "failure",
        errorMsg: "not_found",
        req,
      });
      throw ApiErrors.notFound("Connection not found");
    }

    await logAudit({
      userId: ctx.userId,
      connectionId: id,
      op: "connection.update",
      status: "success",
      req,
    });

    return {
      id: row.id,
      name: row.name,
      accountId: row.accountId,
      accessKeyMasked: row.accessKeyMasked,
      createdAt: row.createdAt.getTime(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    };
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);

// ─── DELETE /api/connections/[id] ───────────────────────────────────────
//
// Refuses if any UNEXPIRED share still references the connection. We do
// NOT cascade — the schema has ON DELETE CASCADE for shares, but the
// product rule is "delete shares first, then the connection" so an
// accidental click cannot silently nuke active short-lived URLs the user
// has already distributed.

export const DELETE = withApi(
  async (req, ctx) => {
    const id = pathSegmentFromEnd(req.url, 0);
    ConnectionIdParamSchema.parse({ id });

    const env = getCloudflareContext().env as unknown as ConnectionsEnv;
    const db = getDb(env);
    const now = new Date();

    // Step 1: verify the connection belongs to this user. We do an explicit
    // SELECT (rather than relying on DELETE … WHERE user_id = ?) because
    // we want to distinguish "doesn't exist" from "exists but has shares".
    const owned = await db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.id, id),
          eq(schema.connections.userId, ctx.userId),
        ),
      )
      .get();
    if (!owned) {
      await logAudit({
        userId: ctx.userId,
        connectionId: id,
        op: "connection.delete",
        status: "failure",
        errorMsg: "not_found",
        req,
      });
      throw ApiErrors.notFound("Connection not found");
    }

    // Step 2: count UNEXPIRED shares pointing at this connection. Expired
    // shares are dead URLs already and don't block deletion — the row will
    // be carried away by cascade harmlessly.
    const sharesCount = await db
      .select({ n: count() })
      .from(schema.shares)
      .where(
        and(
          eq(schema.shares.connectionId, id),
          gt(schema.shares.expiresAt, now),
        ),
      )
      .get();
    const activeShares = sharesCount?.n ?? 0;
    if (activeShares > 0) {
      await logAudit({
        userId: ctx.userId,
        connectionId: id,
        op: "connection.delete",
        status: "failure",
        errorMsg: `blocked_active_shares=${activeShares}`,
        req,
      });
      throw ApiErrors.connectionInUse({ activeShares });
    }

    // Step 3: write the success audit BEFORE the row goes away. The
    // audit_log.connection_id column has ON DELETE SET NULL, but THAT
    // only fires when the cascade runs — it does NOT relax the FK check
    // for a fresh INSERT against an already-deleted id. Inserting first
    // keeps the FK satisfied; if the DELETE below somehow fails after
    // this point, withApi will emit an error response and the misleading
    // "success" row is the price we pay (logging is nofail and SELECT
    // already proved the row exists, so the failure rate is near zero).
    await logAudit({
      userId: ctx.userId,
      connectionId: id,
      op: "connection.delete",
      status: "success",
      req,
    });

    // Step 4: hard delete. Drizzle/D1 will cascade any expired shares per
    // the FK definition; we don't need to clean them up manually.
    await db
      .delete(schema.connections)
      .where(
        and(
          eq(schema.connections.id, id),
          eq(schema.connections.userId, ctx.userId),
        ),
      )
      .run();

    return { ok: true as const, id };
  },
  {
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
