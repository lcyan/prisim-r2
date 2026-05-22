// app/api/share/route.ts
//
// GET /api/share?cursor=<opaque>
//
// Cursor-paginated listing of the current user's *active* (unexpired)
// share records. Returns at most SHARE_LIST_PAGE_SIZE entries, newest first.
//
//   1. validate query             → ShareListQuerySchema (Zod)
//   2. parse cursor               → strict { ts: number, id: string }
//   3. SELECT … WHERE user_id = ctx AND expires_at > now
//                       AND (cursor: createdAt < ts OR (==ts AND id < id))
//                  ORDER BY created_at DESC, id DESC
//                  LIMIT page+1     (peek to detect another page)
//   4. project to ShareSummary (NEVER include url or url_hash)
//   5. emit nextCursor only when there's a (page+1)-th row
//
// Why an explicit cursor (not OFFSET):
//   OFFSET pagination on a sliding-window-filtered query is fragile —
//   inserting/deleting a row mid-scroll either skips or repeats entries.
//   The (createdAt, id) tuple is a stable ordering: id is a ULID, which
//   embeds the timestamp, so identical createdAt values still order
//   deterministically by id.
//
// Why no audit row on read:
//   Same convention as GET /api/connections + /api/r2/list. The listing
//   itself is a high-volume read that adds no security-relevant signal
//   to the audit log; the access happened on share.create / share.delete.
//
// Why no rate limit:
//   GETs against the user's own bookkeeping table are cheap (single
//   indexed query) and the user cannot use this endpoint to enumerate
//   anything outside their own row set.

import "server-only";

import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { z } from "zod";

import { withApi } from "@/lib/api/middleware";
import {
  parseQuery,
  ShareListQuerySchema,
  SHARE_LIST_PAGE_SIZE,
} from "@/lib/api/schemas";
import type { ShareListResponse, ShareSummary } from "@/lib/api/types";
import { getDb, schema, type DbEnv } from "@/lib/db/client";

export const runtime = "edge";

type ShareListEnv = DbEnv;

/**
 * Cursor format: `<createdAt_ms>_<id>` — `_` is unambiguous because the
 * ULID alphabet is Crockford base32 (0-9 + uppercase letters minus I, L,
 * O, U). The leading number is the createdAt epoch ms of the LAST item on
 * the previous page; (`,` is fine too but `_` is URL-safe without any
 * encoding step).
 *
 * Encoded into a stable opaque string for the wire. We do NOT base64-encode
 * — the cursor is already URL-safe and a human-readable cursor helps when
 * grepping logs. We DO bound the length at the schema layer.
 */
function encodeCursor(createdAtMs: number, id: string): string {
  return `${createdAtMs}_${id}`;
}

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

function decodeCursor(raw: string): DecodedCursor | null {
  // Find the underscore between the trailing numeric and the ULID. We
  // deliberately split from the LEFT (indexOf, not lastIndexOf) because
  // ULIDs cannot contain underscores; any underscore in the cursor is
  // unambiguously the separator we wrote.
  const sep = raw.indexOf("_");
  if (sep <= 0 || sep === raw.length - 1) return null;
  const ms = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) return null;
  return { createdAt: new Date(ms), id };
}

export const GET = withApi(async (req, ctx) => {
  const input = await parseQuery(req, ShareListQuerySchema);
  const env = getRequestContext().env as unknown as ShareListEnv;
  const db = getDb(env);

  let cursor: DecodedCursor | null = null;
  if (input.cursor !== undefined) {
    cursor = decodeCursor(input.cursor);
    if (cursor === null) {
      // Surface as a clean 400 via the shared validation pipeline. Throwing
      // a ZodError lets withApi route through `validation.invalid` with the
      // standard flattened-issue payload — keeps the error shape identical
      // to schema-level rejections.
      throw new z.ZodError([
        {
          code: "custom",
          message: "malformed cursor",
          path: ["cursor"],
          input: input.cursor,
        },
      ]);
    }
  }

  const now = new Date();

  // Fetch one extra row to detect "is there a next page". The peek row is
  // sliced off before projecting — only the first SHARE_LIST_PAGE_SIZE
  // items reach the client.
  const peekLimit = SHARE_LIST_PAGE_SIZE + 1;

  const whereExpr = cursor
    ? and(
        eq(schema.shares.userId, ctx.userId),
        gt(schema.shares.expiresAt, now),
        // Strict "next page after the cursor": rows older than the cursor
        // OR same-timestamp rows with an id ordered *before* the cursor's
        // (since ULIDs sort lexicographically and we order DESC).
        or(
          lt(schema.shares.createdAt, cursor.createdAt),
          and(
            eq(schema.shares.createdAt, cursor.createdAt),
            lt(schema.shares.id, cursor.id),
          ),
        ),
      )
    : and(
        eq(schema.shares.userId, ctx.userId),
        gt(schema.shares.expiresAt, now),
      );

  const rows = await db
    .select({
      id: schema.shares.id,
      bucket: schema.shares.bucket,
      objectKey: schema.shares.objectKey,
      ttlSeconds: schema.shares.ttlSeconds,
      createdAt: schema.shares.createdAt,
      expiresAt: schema.shares.expiresAt,
    })
    .from(schema.shares)
    .where(whereExpr)
    .orderBy(desc(schema.shares.createdAt), desc(schema.shares.id))
    .limit(peekLimit)
    .all();

  const pageRows = rows.slice(0, SHARE_LIST_PAGE_SIZE);
  const hasMore = rows.length > SHARE_LIST_PAGE_SIZE;
  // The cursor points at the LAST emitted row — the next request asks for
  // rows strictly after it.
  const tail = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && tail ? encodeCursor(tail.createdAt.getTime(), tail.id) : null;

  const items: ShareSummary[] = pageRows.map((row) => ({
    id: row.id,
    bucket: row.bucket,
    key: row.objectKey,
    ttlSeconds: row.ttlSeconds,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  }));

  const body: ShareListResponse = { items, nextCursor };
  return body;
});
