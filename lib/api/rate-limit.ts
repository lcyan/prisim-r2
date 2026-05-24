// lib/api/rate-limit.ts
//
// Sliding-window rate limiter backed by D1's rate_limit_buckets table
// (see drizzle/migrations/0002_rate_limit_buckets.sql).
//
// Why D1 and not KV/Durable Objects: we already pay a D1 round-trip per
// request for the session revocation check, so adding one UPSERT into the
// same database keeps the request hot path on a single backend. D1 also
// gives us strong consistency for the counter — KV's eventual consistency
// would let 100 parallel requests slip past a 60/min cap.
//
// Why one UPSERT (and not SELECT-then-UPDATE): the atomicity comes for free
// from SQLite's single-statement transaction. A read-then-write would race
// under burst load and lose increments. The CASE expression inside the
// UPDATE branch handles "window has expired, start a new one" in the same
// statement, so we never see a stale-bucket window.

import "server-only";

/**
 * Minimal subset of D1Database used by checkLimit. Carving out this
 * interface (instead of importing D1Database) lets tests pass a
 * better-sqlite3-backed shim without dragging in the full Cloudflare type.
 */
export interface RateLimitDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface CheckLimitOptions {
  db: RateLimitDb;
  /** Pre-composed bucket key — use one of the helpers in RateLimitPolicies
   *  so the format stays consistent across callsites. */
  key: string;
  /** Max allowed events per window. The (limit+1)-th call returns ok=false. */
  limit: number;
  /** Window length in milliseconds. window_start is stored in the same unit. */
  windowMs: number;
  /** Override "now" — used by tests to advance time across the window
   *  boundary deterministically without sleeping. */
  now?: number;
}

export interface CheckLimitResult {
  ok: boolean;
  /** Whole seconds until the current window expires. Always >= 1 when set,
   *  so callers can plug it straight into the Retry-After header. Undefined
   *  when ok=true. */
  retryAfter?: number;
  /** Current count after this attempt (the limited request itself is
   *  counted — that's how UPSERT works). Exposed for audit / debug logs. */
  count: number;
  /** Epoch ms at which the current window started. */
  windowStart: number;
}

// Use plain `?` positional parameters (not `?N` numbered): D1's bind API
// is positional anyway, and better-sqlite3 — the engine the unit tests use
// — miscounts numbered slots when the same number appears more than once,
// which trips the test harness without affecting prod.
const UPSERT_SQL = `
  INSERT INTO rate_limit_buckets (key, count, window_start)
  VALUES (?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE
      WHEN rate_limit_buckets.window_start + ? <= ?
        THEN 1
      ELSE rate_limit_buckets.count + 1
    END,
    window_start = CASE
      WHEN rate_limit_buckets.window_start + ? <= ?
        THEN ?
      ELSE rate_limit_buckets.window_start
    END
  RETURNING count, window_start
`;

/**
 * Atomically increment the bucket for `key`, resetting it if the previous
 * window has expired, and report whether the caller is over `limit`.
 *
 * Concurrency: this is a single UPSERT, so 100 parallel callers will see
 * 100 distinct counts (1..100) with no lost updates — verified in
 * tests/unit/api/rate-limit.test.ts.
 */
export async function checkLimit(
  opts: CheckLimitOptions,
): Promise<CheckLimitResult> {
  const now = opts.now ?? Date.now();
  // Bind order mirrors the `?` occurrences in UPSERT_SQL, top-to-bottom:
  //   1) key                         (INSERT/conflict target)
  //   2) now                         (VALUES window_start)
  //   3) windowMs, 4) now            (count CASE: WHEN start + win <= now)
  //   5) windowMs, 6) now, 7) now    (window_start CASE: same condition,
  //                                    THEN now to reset window_start)
  const row = await opts.db
    .prepare(UPSERT_SQL)
    .bind(opts.key, now, opts.windowMs, now, opts.windowMs, now, now)
    .first<{ count: number; window_start: number }>();

  if (!row) {
    // SQLite UPSERT … RETURNING always yields a row; this branch only fires
    // if the SQL surface changes underneath us. Fail closed: deny the call
    // and ask the client to wait one full window.
    return {
      ok: false,
      count: 0,
      windowStart: now,
      retryAfter: Math.max(1, Math.ceil(opts.windowMs / 1000)),
    };
  }

  const { count, window_start } = row;
  if (count <= opts.limit) {
    return { ok: true, count, windowStart: window_start };
  }
  const remainMs = Math.max(0, window_start + opts.windowMs - now);
  const retryAfter = Math.max(1, Math.ceil(remainMs / 1000));
  return { ok: false, count, windowStart: window_start, retryAfter };
}

/* ─── Policy factories ──────────────────────────────────────────
 *
 * Centralized so handlers don't drift on key format / limit numbers.
 * Tracked policies per PRD §6:
 *   - login:    10 attempts per 5 min, keyed by IP
 *   - presign:  60/min  per user
 *   - share:    30/min  per user
 *   - write agg: 600/min per user (sum of all mutating ops)
 */

const MIN_MS = 60 * 1000;

export const RateLimitPolicies = {
  loginByIp: (ip: string) => ({
    key: `login:ip:${ip}`,
    limit: 10,
    windowMs: 5 * MIN_MS,
  }),
  presignByUser: (userId: string) => ({
    key: `presign:user:${userId}`,
    limit: 60,
    windowMs: MIN_MS,
  }),
  shareCreateByUser: (userId: string) => ({
    key: `share-create:user:${userId}`,
    limit: 30,
    windowMs: MIN_MS,
  }),
  writeAggregateByUser: (userId: string) => ({
    key: `write:user:${userId}`,
    limit: 600,
    windowMs: MIN_MS,
  }),
  dashboardSummaryByUser: (userId: string) => ({
    key: `dashboard:summary:${userId}`,
    limit: 60,
    windowMs: MIN_MS,
  }),
} as const;

export type RateLimitPolicy = ReturnType<
  (typeof RateLimitPolicies)[keyof typeof RateLimitPolicies]
>;

/**
 * Pre-composed policy bundles for the protected mutating endpoints. Each
 * bundle pairs the endpoint-specific limit with the aggregate write budget.
 *
 * Order matters: withApi's rateLimit resolver runs policies left-to-right
 * and stops at the first denial, so the *narrower* limit goes first. That
 * way a user who exceeds 60 presigns/min sees `policy: 'presign:user:…'`,
 * not the generic write-aggregate code — much more actionable.
 *
 * Usage in a future route file (task 15 / task 21):
 *
 *   import { withApi } from "@/lib/api/middleware";
 *   import { RateLimitBundles } from "@/lib/api/rate-limit";
 *
 *   export const POST = withApi(handler, {
 *     rateLimit: ({ ctx }) => RateLimitBundles.presignByUser(ctx.userId),
 *   });
 */
export const RateLimitBundles = {
  presignByUser: (userId: string): RateLimitPolicy[] => [
    RateLimitPolicies.presignByUser(userId),
    RateLimitPolicies.writeAggregateByUser(userId),
  ],
  shareCreateByUser: (userId: string): RateLimitPolicy[] => [
    RateLimitPolicies.shareCreateByUser(userId),
    RateLimitPolicies.writeAggregateByUser(userId),
  ],
  /** Plain write-aggregate-only bundle for routes (delete, multipart, …)
   *  that don't have their own per-endpoint cap but still count toward the
   *  user's 600/min mutating budget. */
  writeOnlyByUser: (userId: string): RateLimitPolicy[] => [
    RateLimitPolicies.writeAggregateByUser(userId),
  ],
  /** GET /api/dashboard/summary fan-outs 6 D1 queries + one R2 listBuckets
   *  per call. Read-only, so no writeAggregate companion — the 60/min cap
   *  alone bounds cost without throttling normal interactive use. */
  dashboardSummaryByUser: (userId: string): RateLimitPolicy[] => [
    RateLimitPolicies.dashboardSummaryByUser(userId),
  ],
} as const;

/**
 * Best-effort client IP extraction. On Cloudflare Pages we always have
 * `cf-connecting-ip` (set by the edge); the `x-forwarded-for` fallback is
 * for local dev / preview behind a reverse proxy. Returns "unknown" rather
 * than throwing so the limiter still buckets unauthenticated traffic — the
 * worst case is that all anon clients share a bucket, which is the safer
 * failure mode (over-limit, not under-limit).
 */
export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  return "unknown";
}
