// lib/dashboard/summary.ts
//
// Pure server-side aggregator for the dashboard page. Seven (+1 recent rows)
// parallel D1 queries collected through Promise.all → DashboardSummary.
//
// bucketsCount is NOT computed here — the caller (route handler) lists
// buckets via the R2 SDK and passes the count in. Keeping the SDK call
// out of this module means:
//   * the function stays D1-only and unit-testable against better-sqlite3
//   * the route can reuse a cached listBuckets result if it ever wires one
//     (today it doesn't — but the boundary is cheap to preserve).

import "server-only";

import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";

import { schema } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import type { AuditEntry, DashboardSummary } from "@/lib/api/types";
import { countActiveRecoveryCodes } from "@/lib/auth/totp-store";

interface SummaryDeps {
  db: Db;
  userId: string;
  bucketsCount: number;
}

interface SummaryInput {
  connectionId: string;
  range: "7d" | "30d";
}

function daysOf(range: "7d" | "30d"): number {
  return range === "7d" ? 7 : 30;
}

export async function getDashboardSummary(
  input: SummaryInput,
  deps: SummaryDeps,
): Promise<DashboardSummary> {
  const { db, userId, bucketsCount } = deps;
  const { connectionId, range } = input;
  const days = daysOf(range);
  const now = new Date();
  const rangeStart = new Date(now.getTime() - days * 86_400_000);
  const prevStart = new Date(now.getTime() - 2 * days * 86_400_000);
  // opsByType always shows a 7d window regardless of selected range — the
  // bar list is meant for "what's been busy lately", not the longer trend
  // already in opsByDay.
  const sevenDayStart = new Date(now.getTime() - 7 * 86_400_000);

  // shares aggregate uses bare SQL (CASE WHEN sums), so we bind seconds
  // explicitly rather than letting drizzle serialize a Date object — the
  // expires_at column is stored as unix seconds via timestamp mode.
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const expiring7dEpoch = nowEpoch + 7 * 86_400;

  const [
    opsTotal,
    opsPrev,
    failuresTotal,
    sharesAggregate,
    opsByTypeRows,
    opsByDayRows,
    recentRows,
    recoveryCodesRemaining,
  ] = await Promise.all([
    // 1. current-window op count
    db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, rangeStart),
        ),
      ),
    // 2. previous equal-length window (used by formatDelta on the client)
    db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, prevStart),
          lt(schema.auditLog.createdAt, rangeStart),
        ),
      ),
    // 3. failures within current window
    db
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          eq(schema.auditLog.status, "failure"),
          gte(schema.auditLog.createdAt, rangeStart),
        ),
      ),
    // 4. shares aggregate — active + expiring within 7d
    db
      .select({
        active: sql<number>`SUM(CASE WHEN ${schema.shares.expiresAt} > ${nowEpoch} THEN 1 ELSE 0 END)`,
        expiring7d: sql<number>`SUM(CASE WHEN ${schema.shares.expiresAt} > ${nowEpoch} AND ${schema.shares.expiresAt} <= ${expiring7dEpoch} THEN 1 ELSE 0 END)`,
      })
      .from(schema.shares)
      .where(eq(schema.shares.userId, userId)),
    // 5. ops by type (7d window for the chart, regardless of selected range)
    db
      .select({ op: schema.auditLog.op, n: count() })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, sevenDayStart),
        ),
      )
      .groupBy(schema.auditLog.op),
    // 6. ops grouped by day. `created_at` is stored as unix seconds; strftime
    // formats it via the unixepoch modifier so the day key is YYYY-MM-DD.
    db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', datetime(${schema.auditLog.createdAt}, 'unixepoch'))`,
        n: count(),
      })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.userId, userId),
          eq(schema.auditLog.connectionId, connectionId),
          gte(schema.auditLog.createdAt, rangeStart),
        ),
      )
      .groupBy(
        sql`strftime('%Y-%m-%d', datetime(${schema.auditLog.createdAt}, 'unixepoch'))`,
      ),
    // 7. last 10 audit rows for the activity panel
    db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.userId, userId))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(10),
    // 8. unconsumed recovery codes count for the low-codes banner
    countActiveRecoveryCodes(db, userId),
  ]);

  const currentOps = opsTotal[0]?.n ?? 0;
  const prevOps = opsPrev[0]?.n ?? 0;
  const failuresN = failuresTotal[0]?.n ?? 0;
  const ratePct = currentOps === 0 ? 0 : (failuresN / currentOps) * 100;

  // Pad opsByDay to exactly `days` slots so the chart x-axis has a fixed
  // length regardless of which days actually have entries.
  const opsByDayMap = new Map(opsByDayRows.map((r) => [r.day, r.n]));
  const opsByDay: Array<{ date: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const dayKey = d.toISOString().slice(0, 10);
    opsByDay.push({ date: dayKey, count: opsByDayMap.get(dayKey) ?? 0 });
  }

  const opsByType = opsByTypeRows
    .map((r) => ({ op: r.op, count: r.n }))
    .sort((a, b) => b.count - a.count);

  const recentActivity: AuditEntry[] = recentRows.map((r) => ({
    id: r.id,
    op: r.op,
    status: r.status === "failure" ? "failure" : "success",
    bucket: r.bucket,
    key: r.objectKey,
    connectionId: r.connectionId,
    errorMsg: r.errorMsg,
    ip: r.ip,
    ua: r.ua,
    createdAt:
      r.createdAt instanceof Date
        ? r.createdAt.getTime()
        : Number(r.createdAt) * 1000,
  }));

  return {
    bucketsCount,
    shares: {
      active: Number(sharesAggregate[0]?.active ?? 0),
      expiring7d: Number(sharesAggregate[0]?.expiring7d ?? 0),
    },
    ops: {
      count: currentOps,
      previousCount: prevOps,
    },
    failures: {
      count: failuresN,
      ratePct,
    },
    opsByDay,
    opsByType,
    recentActivity,
    totp: { recoveryCodesRemaining },
  };
}
