import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import type { BucketUsageSummary } from "@/lib/api/types";
import type { Db } from "@/lib/db/client";
import { bucketUsageCache } from "@/lib/db/schema";

export const BUCKET_USAGE_CACHE_TTL_MS = 15 * 60 * 1000;
export const BUCKET_USAGE_MAX_BUCKETS_PER_REQUEST = 3;
export const BUCKET_USAGE_MAX_OBJECTS_PER_BUCKET = 20_000;
export const BUCKET_USAGE_MAX_PAGES_PER_BUCKET = 20;

interface CacheKey {
  userId: string;
  connectionId: string;
}

function toUsage(row: typeof bucketUsageCache.$inferSelect): BucketUsageSummary {
  return {
    objectCount: row.objectCount,
    totalBytes: row.totalBytes,
    scannedAt: row.scannedAt ? row.scannedAt.getTime() : null,
    stale: row.stale,
    truncated: row.truncated,
    error: row.errorMsg,
  };
}

export async function readBucketUsageCache(
  db: Db,
  key: CacheKey,
  buckets: string[],
): Promise<Map<string, BucketUsageSummary>> {
  if (buckets.length === 0) return new Map();
  const rows = await db.query.bucketUsageCache.findMany({
    where: and(
      eq(bucketUsageCache.userId, key.userId),
      eq(bucketUsageCache.connectionId, key.connectionId),
      inArray(bucketUsageCache.bucket, buckets),
    ),
  });
  return new Map(rows.map((row) => [row.bucket, toUsage(row)]));
}

export function usageNeedsRefresh(
  usage: BucketUsageSummary | null,
  nowMs: number,
): boolean {
  if (!usage?.scannedAt) return true;
  return nowMs - usage.scannedAt > BUCKET_USAGE_CACHE_TTL_MS;
}

export async function upsertBucketUsageSuccess(
  db: Db,
  key: CacheKey & { bucket: string },
  usage: { objectCount: number; totalBytes: number; truncated: boolean },
  now: Date,
): Promise<BucketUsageSummary> {
  await db
    .insert(bucketUsageCache)
    .values({
      userId: key.userId,
      connectionId: key.connectionId,
      bucket: key.bucket,
      objectCount: usage.objectCount,
      totalBytes: usage.totalBytes,
      scannedAt: now,
      stale: false,
      truncated: usage.truncated,
      errorMsg: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        bucketUsageCache.userId,
        bucketUsageCache.connectionId,
        bucketUsageCache.bucket,
      ],
      set: {
        objectCount: usage.objectCount,
        totalBytes: usage.totalBytes,
        scannedAt: now,
        stale: false,
        truncated: usage.truncated,
        errorMsg: null,
        updatedAt: now,
      },
    });

  return {
    objectCount: usage.objectCount,
    totalBytes: usage.totalBytes,
    scannedAt: now.getTime(),
    stale: false,
    truncated: usage.truncated,
    error: null,
  };
}

export async function upsertBucketUsageFailure(
  db: Db,
  key: CacheKey & { bucket: string },
  now: Date,
): Promise<BucketUsageSummary> {
  await db
    .insert(bucketUsageCache)
    .values({
      userId: key.userId,
      connectionId: key.connectionId,
      bucket: key.bucket,
      objectCount: 0,
      totalBytes: 0,
      scannedAt: now,
      stale: true,
      truncated: false,
      errorMsg: "usage_unavailable",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        bucketUsageCache.userId,
        bucketUsageCache.connectionId,
        bucketUsageCache.bucket,
      ],
      set: {
        stale: true,
        errorMsg: "usage_unavailable",
        updatedAt: now,
      },
    });

  return {
    objectCount: 0,
    totalBytes: 0,
    scannedAt: now.getTime(),
    stale: true,
    truncated: false,
    error: "usage_unavailable",
  };
}
