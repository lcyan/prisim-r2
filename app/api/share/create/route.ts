// app/api/share/create/route.ts
//
// POST /api/share/create — mint a long-lived presigned GET against an R2
// object and persist a `shares` row so the user can review/delete the
// bookkeeping record later. The URL itself is returned ONCE in the create
// response and never round-trips through the listing endpoint — the row
// stores only a sha256 of it (`url_hash`) so we can correlate audit hits
// without persisting a bearer credential.
//
//   1. validate input              → ShareCreateSchema (Zod)
//   2. resolve connection          → user-scoped row + AAD-bound decrypt
//                                    (lib/r2/route-helpers.ts)
//   3. presignGet(ttlSeconds)      → URL valid for the chosen window
//   4. INSERT shares row           → with url_hash = sha256(url)
//   5. audit share.create + return → { id, url, expiresAt }
//
// Notes worth knowing before touching this file:
//
// * TTL is constrained to three literals (1h / 1d / 7d) at the schema
//   boundary. Don't loosen this — letting a client pick "31 days" makes a
//   leaked URL a 30× bigger blast radius and bypasses the share-create
//   rate limit's intent (it caps QPS, not aggregate exposure).
// * The URL is computed AFTER the connection lookup + decrypt but BEFORE
//   the row insert. If the insert fails we still leak nothing (the URL
//   exists only in this handler's frame), but we DO log a failure audit
//   row so an operator can see "presign succeeded, row insert didn't" —
//   that pattern would point at a corrupted shares index or D1 outage.
//   THIS extra audit branch is why we don't use runR2WithAudit here.
// * The presign goes through the SAME `presignGet` helper as the download
//   route (15-min TTL there, longer here). That's intentional — the
//   signature semantics are identical; only the TTL differs.
// * Rate limit is share-create-specific (30/min/user from PRD §6) PLUS
//   the write-aggregate budget. Order: narrowest first, so the 31st call
//   in a minute trips `share-create:user:*` with a clear `policy` value.
// * The url_hash is stored as 64-char hex (sha256). NEVER persist the
//   raw URL — even one row in audit_log or the shares table would
//   undermine invariant #3.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ulid } from "ulid";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { parseJson, ShareCreateSchema } from "@/lib/api/schemas";
import type { ShareCreateResponse } from "@/lib/api/types";
import { schema, type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { presignGet } from "@/lib/r2/presign";
import { R2CredentialError } from "@/lib/r2/errors";
import { resolveConnectionForR2 } from "@/lib/r2/route-helpers";
import { logAudit } from "@/lib/audit/log";

type ShareEnv = DbEnv & CryptoEnv;

/** sha256 hex of an arbitrary string. Used to fingerprint the minted URL
 *  for the `shares.url_hash` column — never the URL itself. Web Crypto only
 *  (no node:crypto). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, ShareCreateSchema);
    const env = getCloudflareContext().env as unknown as ShareEnv;

    const { db, connection, client } = await resolveConnectionForR2({
      cid: input.cid,
      userId: ctx.userId,
      env,
      req,
      purpose: "share",
      auditBucket: input.bucket,
      auditKey: input.key,
    });

    let url: string;
    try {
      url = await presignGet({
        client,
        bucket: input.bucket,
        key: input.key,
        ttl: input.ttlSeconds,
      });
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "share.create",
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg: err instanceof Error ? err.name : "presign failed",
        req,
      });
      if (err instanceof R2CredentialError) {
        throw ApiErrors.unauthorized("R2 credentials rejected");
      }
      throw err;
    }

    const id = ulid();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + input.ttlSeconds * 1000);
    const urlHash = await sha256Hex(url);

    try {
      await db.insert(schema.shares).values({
        id,
        userId: ctx.userId,
        connectionId: connection.id,
        bucket: input.bucket,
        objectKey: input.key,
        urlHash,
        ttlSeconds: input.ttlSeconds,
        expiresAt,
        createdAt,
      });
    } catch (err) {
      // Insert failure is rare (FK already satisfied, ULID is fresh). Audit
      // separately so an operator can spot "presign worked, row didn't" —
      // the URL is already minted, but the user has no bookkeeping record
      // and the response would lie if we returned 200.
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "share.create",
        bucket: input.bucket,
        key: input.key,
        status: "failure",
        errorMsg:
          err instanceof Error ? `insert_failed: ${err.name}` : "insert_failed",
        req,
      });
      throw err;
    }

    await logAudit({
      userId: ctx.userId,
      connectionId: connection.id,
      op: "share.create",
      bucket: input.bucket,
      key: input.key,
      status: "success",
      req,
    });

    const body: ShareCreateResponse = {
      id,
      url,
      expiresAt: expiresAt.getTime(),
    };
    return body;
  },
  {
    // share-create cap first (30/min/user) — narrowest hit so the user sees
    // an actionable policy code rather than the generic write-aggregate one.
    rateLimit: ({ ctx }) => RateLimitBundles.shareCreateByUser(ctx.userId),
  },
);
