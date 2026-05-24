// app/api/share/[id]/reveal/route.ts
//
// POST /api/share/[id]/reveal — re-mint a presigned GET URL for an
// existing share row. Solves a real UX gap: share-create returns the URL
// exactly once and we deliberately do NOT persist the raw URL (only its
// sha256), so a user who closes the dialog without copying loses access
// to their own bookkeeping. Reveal recreates a URL with the SAME wall-
// clock expiry as the row, so links handed out from reveal align with
// what the user already promised the recipient.
//
//   1. validate path param         → ShareIdParamSchema (Zod)
//   2. SELECT share row WHERE id = ? AND user_id = ? AND expires_at > now()
//   3. SELECT connection            → enforce user scope
//   4. decrypt access/secret keys   → AES-GCM with AAD = connection.id
//   5. compute remaining TTL secs   → floor((expiresAt - now) / 1000)
//   6. presignGet(remaining)        → fresh signature, same expiry instant
//   7. audit share.reveal + return  → { id, url, expiresAt }
//
// Notes worth knowing before touching this file:
//
// * The returned URL is a NEW signature, not the original. Both work
//   until expiresAt — R2 does not expose a revocation primitive, so the
//   original URL keeps functioning until its window closes naturally.
//   This is consistent with how share.delete is documented.
// * Expired rows return 404, matching what GET /api/share already does
//   (the listing filters them out with `WHERE expires_at > now()`); we do
//   not want to leak whether an id existed-but-expired vs never existed.
// * Rate limit reuses the presign bundle (60/min per user + 600/min write
//   aggregate). Reveal is a presign operation in everything but name.
// * No url_hash update: the new URL has a different signature, but we
//   intentionally don't overwrite the row's url_hash. The hash is a
//   server-side fingerprint of the FIRST minted URL; replacing it would
//   hide a future audit trail without buying anything (we never compare
//   it to anything user-facing).

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { ShareIdParamSchema } from "@/lib/api/schemas";
import type { ShareRevealResponse } from "@/lib/api/types";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { presignGet } from "@/lib/r2/presign";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type ShareRevealEnv = DbEnv & CryptoEnv;

/** Extract `[id]` from `/api/share/<id>/reveal`. Same pattern as the sibling
 *  DELETE route — withApi narrows the handler to a single Request, so we
 *  re-derive the path segment instead of threading Next 15's params context. */
function pathIdFrom(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  // .../share/<id>/reveal — the id is the second-to-last segment.
  return parts[parts.length - 2] ?? "";
}

export const POST = withApi(
  async (req, ctx) => {
    const id = pathIdFrom(req.url);
    ShareIdParamSchema.parse({ id });

    const env = getRequestContext().env as unknown as ShareRevealEnv;
    const db = getDb(env);

    // Load the share row scoped by user_id. We compute "expired?" in
    // application code rather than `WHERE expires_at > now()` so we can
    // tell apart "never existed" (no row) from "existed but expired" for
    // the audit log — both surface as 404 to the client.
    const row = await db
      .select({
        id: schema.shares.id,
        connectionId: schema.shares.connectionId,
        bucket: schema.shares.bucket,
        objectKey: schema.shares.objectKey,
        expiresAt: schema.shares.expiresAt,
      })
      .from(schema.shares)
      .where(
        and(
          eq(schema.shares.id, id),
          eq(schema.shares.userId, ctx.userId),
        ),
      )
      .get();

    if (!row) {
      await logAudit({
        userId: ctx.userId,
        connectionId: null,
        op: "share.reveal",
        status: "failure",
        errorMsg: "not_found",
        req,
      });
      throw ApiErrors.notFound("Share not found");
    }

    const nowMs = Date.now();
    const expiresAtMs = row.expiresAt.getTime();
    const remainingSecs = Math.floor((expiresAtMs - nowMs) / 1000);
    if (remainingSecs <= 0) {
      await logAudit({
        userId: ctx.userId,
        connectionId: row.connectionId,
        op: "share.reveal",
        bucket: row.bucket,
        key: row.objectKey,
        status: "failure",
        errorMsg: "expired",
        req,
      });
      // Same 404 as the missing-row case so we never disclose whether a
      // share id existed-but-expired vs never existed.
      throw ApiErrors.notFound("Share not found");
    }

    const connection = await db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.id, row.connectionId),
          eq(schema.connections.userId, ctx.userId),
        ),
      )
      .get();
    if (!connection) {
      // Share row outlived its connection (cascade delete missed? FK
      // intentionally `set null`?). Treat as 404 — the share is no longer
      // re-mintable. We still audit so an operator can spot the orphan.
      await logAudit({
        userId: ctx.userId,
        connectionId: row.connectionId,
        op: "share.reveal",
        bucket: row.bucket,
        key: row.objectKey,
        status: "failure",
        errorMsg: "connection_missing",
        req,
      });
      throw ApiErrors.notFound("Connection no longer available");
    }

    let accessKeyId: string;
    let secretAccessKey: string;
    try {
      [accessKeyId, secretAccessKey] = await Promise.all([
        decryptCredential(
          asU8(connection.accessKeyCiphertext, "share/reveal"),
          asU8(connection.accessKeyIv, "share/reveal"),
          connection.id,
          env,
        ),
        decryptCredential(
          asU8(connection.secretKeyCiphertext, "share/reveal"),
          asU8(connection.secretKeyIv, "share/reveal"),
          connection.id,
          env,
        ),
      ]);
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "security.decrypt_failed",
        bucket: row.bucket,
        key: row.objectKey,
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

    let url: string;
    try {
      url = await presignGet({
        client,
        bucket: row.bucket,
        key: row.objectKey,
        ttl: remainingSecs,
      });
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "share.reveal",
        bucket: row.bucket,
        key: row.objectKey,
        status: "failure",
        errorMsg: err instanceof Error ? err.name : "presign failed",
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
      op: "share.reveal",
      bucket: row.bucket,
      key: row.objectKey,
      status: "success",
      req,
    });

    const body: ShareRevealResponse = {
      id: row.id,
      url,
      expiresAt: expiresAtMs,
    };
    return body;
  },
  {
    // Reveal is a presign in disguise — bill it against the same presign
    // bucket so a user spamming the button trips a presign:user:* policy,
    // not the generic write-aggregate one.
    rateLimit: ({ ctx }) => RateLimitBundles.presignByUser(ctx.userId),
  },
);
