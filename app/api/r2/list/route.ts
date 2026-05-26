// app/api/r2/list/route.ts
//
// GET /api/r2/list?cid=<ULID>&bucket=<name>&prefix=<str>&cursor=<opaque>
//
// Folder-style listing for the file browser. The handler:
//
//   1. validate query             → R2ListQuerySchema (Zod)
//   2. resolve connection         → user-scoped row + AAD-bound decrypt
//                                   (lib/r2/route-helpers.ts)
//   3. listObjects via R2 SDK     → Delimiter='/' to fold deeper keys
//                                   into CommonPrefixes (folder listing)
//   4. update last_used_at        → fire-and-forget after the body lands
//   5. return R2ListResponse
//
// Notes worth knowing before touching this file:
//
// * Same pattern + same trade-offs as the buckets route (see comments
//   there). GET is exempt from CSRF in withApi. No rate limit — the UI
//   sits behind TanStack Query's cache and the natural client cap is
//   already tight; one round-trip costs us one decrypt + one R2 hit,
//   not object bytes (CLAUDE.md security invariant #3).
// * No audit on success (high-volume read, matches GET /api/connections
//   + GET /api/r2/buckets policy). Decryption failures ARE audited
//   inside resolveConnectionForR2 under `security.decrypt_failed`.
// * Page size is fixed server-side via R2_LIST_DEFAULT_MAX_KEYS (200) —
//   the client cannot override. This bounds per-request work regardless
//   of caller behavior. Pagination is cursor-based (NextContinuationToken)
//   not offset-based; the client surfaces `nextCursor` straight back into
//   the next request.
// * Empty bucket / empty page returns the stable shape
//     { objects: [], prefixes: [], nextCursor: null }
//   so consumers don't need to defensively `?? []` on every field.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import {
  parseQuery,
  R2ListQuerySchema,
  R2_LIST_DEFAULT_MAX_KEYS,
} from "@/lib/api/schemas";
import type { R2ListObject, R2ListResponse } from "@/lib/api/types";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { listObjects } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import {
  resolveConnectionForR2,
  touchConnectionLastUsed,
} from "@/lib/r2/route-helpers";


type ListEnv = DbEnv & CryptoEnv;

export const GET = withApi(async (req, ctx) => {
  const input = await parseQuery(req, R2ListQuerySchema);
  const env = getCloudflareContext().env as unknown as ListEnv;

  const { db, connection, client } = await resolveConnectionForR2({
    cid: input.cid,
    userId: ctx.userId,
    env,
    req,
    purpose: "list",
    auditBucket: input.bucket,
  });

  let raw: Awaited<ReturnType<typeof listObjects>>;
  try {
    raw = await listObjects({
      client,
      bucket: input.bucket,
      prefix: input.prefix,
      // Folder-style listing — fold every key past the next "/" into
      // CommonPrefixes. Hardcoded "/" rather than parameterized: the
      // entire UI assumes the slash convention, and exposing a custom
      // delimiter would surprise the file browser more than it helps.
      delimiter: "/",
      continuationToken: input.cursor,
      maxKeys: R2_LIST_DEFAULT_MAX_KEYS,
    });
  } catch (err) {
    if (err instanceof R2CredentialError) {
      throw ApiErrors.unauthorized("R2 credentials rejected");
    }
    throw err;
  }

  // Normalize SDK shapes (optional fields → null) so the wire payload is
  // stable across SDK versions and easy to consume from the browser.
  const objects: R2ListObject[] = raw.items.map((item) => ({
    key: item.key,
    size: typeof item.size === "number" ? item.size : null,
    etag: typeof item.etag === "string" ? item.etag : null,
    lastModified:
      item.lastModified instanceof Date ? item.lastModified.getTime() : null,
  }));

  const body: R2ListResponse = {
    objects,
    prefixes: raw.prefixes,
    // Coerce undefined → null so JSON consumers see an explicit "no more
    // pages" sentinel rather than the key being absent entirely.
    nextCursor: raw.continuationToken ?? null,
  };

  await touchConnectionLastUsed(db, {
    connectionId: connection.id,
    userId: ctx.userId,
    requestId: ctx.requestId,
    tag: "list",
  });

  return body;
});
