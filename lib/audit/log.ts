// lib/audit/log.ts
//
// Audit-log writer. Backs the `audit_log` table declared in
// lib/db/schema.ts and persisted by drizzle/migrations/0000_init.sql.
//
// Design choices
// --------------
//   * Nofail: every callsite is in the hot path of a security-sensitive
//     route (login, presign, delete, …). A telemetry insert MUST NOT block
//     or fail the user-facing request — we wrap the insert in try/catch
//     and only `console.error` on failure so the request flow continues.
//   * No size / class / bytes columns: V2 will surface object-byte traffic
//     via Cloudflare Analytics (R2 itself already emits per-bucket metrics).
//     We deliberately keep the row narrow so D1 stays cheap and the table
//     index (idx_audit_user_time) stays selective.
//   * `req` is optional, not required: most callers run inside a route
//     handler that has the Request object, but a few hooks (e.g.
//     `events.signOut` in next-auth) fire outside any request context.
//     When omitted, ip and ua are written as NULL — still better than
//     dropping the record entirely.
//   * `db` is an optional second argument. Production callers omit it and
//     we resolve the D1 binding via `getCloudflareContext()`. Unit tests
//     inject a stub so they don't need to mock the Cloudflare runtime.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ulid } from "ulid";

import { parseClientIp } from "@/lib/api/client-ip";
import { AUDIT_OP_VALUES, type AuditOpValue } from "@/lib/api/schemas";
import { getDb, schema, type Db, type DbEnv } from "@/lib/db/client";

/**
 * Closed set of operations the system audits. Adding a value here is the
 * forcing-function for new endpoints — TypeScript will refuse any string
 * literal not in this union, so a typo at the callsite is caught at
 * compile time rather than producing an un-greppable audit row.
 *
 * Mirrored as a Zod enum (AUDIT_OP_VALUES) in lib/api/schemas.ts so the
 * GET /api/audit filter dropdown stays in lockstep. The two `satisfies`
 * checks below assert that the writer's union and the reader's enum
 * cover the exact same set — adding to one without the other is a
 * typecheck error.
 */
export type AuditOp = AuditOpValue;

// Force the two lists to agree at compile time.
const _opUnionCoversEnum = AUDIT_OP_VALUES satisfies readonly AuditOp[];
void _opUnionCoversEnum;

/** Outcome of the audited operation. Stored verbatim in `audit_log.status`. */
export type AuditStatus = "success" | "failure";

export interface LogAuditInput {
  /** Authenticated user. NULL is allowed for pre-session events such as a
   *  failed login where we never resolved a user row. */
  userId: string | null;
  connectionId?: string | null;
  op: AuditOp;
  bucket?: string | null;
  /** Object key. The DB column is `object_key`; we expose `key` here to
   *  match the rest of the codebase's R2 vocabulary. */
  key?: string | null;
  status: AuditStatus;
  errorMsg?: string | null;
  /** Origin request — used to extract IP + UA. Optional because some
   *  callers (next-auth events) fire outside a request scope. */
  req?: Request | null;
}

interface RequestMeta {
  ip: string | null;
  ua: string | null;
}

/**
 * Pull IP and UA out of the request headers.
 *
 * IP extraction is shared with the rate limiter via parseClientIp — see
 * lib/api/client-ip.ts. UA is the plain `user-agent` header. Both return
 * null when the header is missing rather than a sentinel string so the
 * audit table can SQL-filter on `IS NULL` unambiguously.
 */
export function extractAuditMeta(req: Request | null | undefined): RequestMeta {
  if (!req) return { ip: null, ua: null };
  const ip = parseClientIp(req.headers);
  const uaHeader = req.headers.get("user-agent");
  const ua = uaHeader && uaHeader.trim().length > 0 ? uaHeader.trim() : null;
  return { ip, ua };
}

/**
 * Write one audit row. Never throws — a failure to log MUST NOT break the
 * user-facing operation. The caller does not need to await the result for
 * correctness; awaiting is encouraged in route handlers so the row is
 * flushed before the response goes out (and the request hasn't returned
 * before the Pages worker's event loop spins down).
 *
 * @param input  Row fields + originating Request.
 * @param db     Optional Drizzle client. Production callers omit this so
 *               the D1 binding is resolved from `getCloudflareContext()`;
 *               tests inject a stub.
 */
export async function logAudit(input: LogAuditInput, db?: Db): Promise<void> {
  try {
    const database =
      db ?? getDb(getCloudflareContext().env as unknown as DbEnv);
    const { ip, ua } = extractAuditMeta(input.req);

    await database.insert(schema.auditLog).values({
      id: ulid(),
      userId: input.userId,
      connectionId: input.connectionId ?? null,
      op: input.op,
      bucket: input.bucket ?? null,
      objectKey: input.key ?? null,
      status: input.status,
      errorMsg: input.errorMsg ?? null,
      ip,
      ua,
    });
  } catch (err) {
    // Nofail: surface enough detail to debug from logs, but never rethrow.
    // We don't include the full input (it may contain a key path users
    // consider private) — just op + status is enough to correlate with
    // the rest of the request's structured logs via requestId.
    console.error(
      `[audit] insert failed for op=${input.op} status=${input.status}`,
      err,
    );
  }
}
