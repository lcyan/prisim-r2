// app/api/audit/route.ts
//
// GET /api/audit?cursor=<opaque>&op=<AuditOp>&bucket=<name>
//
// Cursor-paginated listing of the current user's audit_log rows. Returns
// at most AUDIT_LIST_PAGE_SIZE entries, newest first.
//
//   1. validate query             → AuditListQuerySchema (Zod)
//   2. parse cursor               → strict { ts: number, id: string }
//   3. SELECT … WHERE user_id = ctx
//                       AND (op = ? optional)
//                       AND (bucket = ? optional)
//                       AND (cursor: createdAt < ts OR (==ts AND id < id))
//                  ORDER BY created_at DESC, id DESC
//                  LIMIT page+1     (peek to detect another page)
//   4. project to AuditEntry (timestamps → epoch ms; nullable fields kept)
//   5. emit nextCursor only when there's a (page+1)-th row
//
// Why no audit row on read:
//   Same convention as GET /api/connections, /api/share, /api/r2/list.
//   Reading the audit table itself is not security-relevant in V1 (the
//   user can only see their own rows); auditing the audit reader would
//   double the table size for no signal.
//
// Why no rate limit:
//   GETs against the user's own bookkeeping table are cheap (single
//   indexed query via idx_audit_user_time) and the user cannot use this
//   endpoint to enumerate anything outside their own row set.
//
// Cursor format:
//   `<createdAt_ms>_<id>` — same shape as the share-list endpoint. The
//   audit_log primary key is a ULID, so the (createdAt, id) tuple is a
//   stable ordering even when two rows share a millisecond. We do NOT
//   base64-encode — the cursor is already URL-safe and a human-readable
//   cursor helps when grepping request logs.

import "server-only";

import { and, desc, eq, lt, or } from "drizzle-orm";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";

import { withApi } from "@/lib/api/middleware";
import {
  parseQuery,
  AuditListQuerySchema,
  AUDIT_LIST_PAGE_SIZE,
} from "@/lib/api/schemas";
import type { AuditEntry, AuditListResponse } from "@/lib/api/types";
import { getDb, schema, type DbEnv } from "@/lib/db/client";

type AuditListEnv = DbEnv;

function encodeCursor(createdAtMs: number, id: string): string {
  return `${createdAtMs}_${id}`;
}

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

function decodeCursor(raw: string): DecodedCursor | null {
  // ULIDs cannot contain underscores (Crockford base32 alphabet), so the
  // first `_` is unambiguously our separator. Split from the LEFT.
  const sep = raw.indexOf("_");
  if (sep <= 0 || sep === raw.length - 1) return null;
  const ms = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) return null;
  return { createdAt: new Date(ms), id };
}

export const GET = withApi(async (req, ctx) => {
  const input = await parseQuery(req, AuditListQuerySchema);
  const env = getCloudflareContext().env as unknown as AuditListEnv;
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

  // Compose the WHERE clause from the always-present user filter and any
  // optional filters/cursor. drizzle's `and(...)` accepts undefined
  // entries — they're stripped — so we can spread conditionally without
  // building an array imperatively.
  const userFilter = eq(schema.auditLog.userId, ctx.userId);
  const opFilter = input.op ? eq(schema.auditLog.op, input.op) : undefined;
  const bucketFilter = input.bucket
    ? eq(schema.auditLog.bucket, input.bucket)
    : undefined;
  const cursorFilter = cursor
    ? or(
        lt(schema.auditLog.createdAt, cursor.createdAt),
        and(
          eq(schema.auditLog.createdAt, cursor.createdAt),
          lt(schema.auditLog.id, cursor.id),
        ),
      )
    : undefined;

  const whereExpr = and(userFilter, opFilter, bucketFilter, cursorFilter);

  // Fetch one extra row to detect "is there a next page". The peek row
  // is sliced off before projecting — only the first AUDIT_LIST_PAGE_SIZE
  // items reach the client.
  const peekLimit = AUDIT_LIST_PAGE_SIZE + 1;

  const rows = await db
    .select({
      id: schema.auditLog.id,
      op: schema.auditLog.op,
      status: schema.auditLog.status,
      bucket: schema.auditLog.bucket,
      objectKey: schema.auditLog.objectKey,
      connectionId: schema.auditLog.connectionId,
      errorMsg: schema.auditLog.errorMsg,
      ip: schema.auditLog.ip,
      ua: schema.auditLog.ua,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(whereExpr)
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(peekLimit)
    .all();

  const pageRows = rows.slice(0, AUDIT_LIST_PAGE_SIZE);
  const hasMore = rows.length > AUDIT_LIST_PAGE_SIZE;
  // Cursor points at the LAST emitted row — the next request asks for
  // rows strictly after it (the OR/AND tuple in the WHERE clause).
  const tail = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && tail ? encodeCursor(tail.createdAt.getTime(), tail.id) : null;

  const items: AuditEntry[] = pageRows.map((row) => ({
    id: row.id,
    op: row.op,
    // status is a string in the DB schema; narrow to the union for the
    // wire type so clients don't need to assert on each row.
    status: row.status === "failure" ? "failure" : "success",
    bucket: row.bucket,
    key: row.objectKey,
    connectionId: row.connectionId,
    errorMsg: row.errorMsg,
    ip: row.ip,
    ua: row.ua,
    createdAt: row.createdAt.getTime(),
  }));

  const body: AuditListResponse = { items, nextCursor };
  return body;
});
