// app/api/r2/buckets/route.ts
//
// GET /api/r2/buckets?cid=<ULID>
//
// Read-only listing of the R2 buckets visible to one of the user's saved
// connections. The handler:
//
//   1. validate query             → R2BucketsQuerySchema (Zod)
//   2. resolve connection         → user-scoped row + AAD-bound decrypt
//                                   (lib/r2/route-helpers.ts)
//   3. listBuckets via R2 SDK     → control-plane only, no body I/O
//   4. update last_used_at        → fire-and-forget after the body lands
//   5. return BucketSummary[]
//
// Notes worth knowing before touching this file:
//
// * GET is exempt from CSRF (withApi only enforces it on mutating verbs),
//   so the client doesn't need to mint a token to refresh the dropdown.
//   Read-aggregate rate limiting is NOT applied here because every bucket
//   list eats one R2 round-trip + one credential decrypt, and the UI sits
//   behind TanStack Query's 5-minute staleTime — the natural client cap
//   is already tight. If we ever expose this without that cache, add
//   `RateLimitPolicies.presignByUser` (the closest existing per-user
//   policy that already gates R2-bound work) and wire a `rateLimit` field
//   below.
// * `last_used_at` is updated INSIDE the request (not via a background
//   trigger) so the dashboard's "last used X ago" indicator reflects the
//   real usage timestamp. We update it after listBuckets succeeds but
//   before returning — failure to write the timestamp is non-fatal and
//   does not roll back the response.
// * Audit logging: success listings are NOT audited (high-volume read,
//   no security-relevant info — matches the GET /api/connections policy
//   in CLAUDE.md). Decryption failures ARE audited inside
//   resolveConnectionForR2 under `security.decrypt_failed`.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { parseQuery, R2BucketsQuerySchema } from "@/lib/api/schemas";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import type { BucketSummary } from "@/lib/api/types";
import {
  BUCKET_USAGE_MAX_BUCKETS_PER_REQUEST,
  BUCKET_USAGE_MAX_OBJECTS_PER_BUCKET,
  BUCKET_USAGE_MAX_PAGES_PER_BUCKET,
  readBucketUsageCache,
  upsertBucketUsageFailure,
  upsertBucketUsageSuccess,
  usageNeedsRefresh,
} from "@/lib/r2/bucket-usage-cache";
import { listBuckets, summarizeBucketUsage } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import {
  resolveConnectionForR2,
  touchConnectionLastUsed,
} from "@/lib/r2/route-helpers";

type BucketsEnv = DbEnv & CryptoEnv;

export const GET = withApi(async (req, ctx) => {
  const input = await parseQuery(req, R2BucketsQuerySchema);
  const env = getCloudflareContext().env as unknown as BucketsEnv;

  const { db, connection, client } = await resolveConnectionForR2({
    cid: input.cid,
    userId: ctx.userId,
    env,
    req,
    purpose: "buckets",
  });

  let raw: Awaited<ReturnType<typeof listBuckets>>;
  try {
    raw = await listBuckets({ client });
  } catch (err) {
    if (err instanceof R2CredentialError) {
      // The user's R2 keys (not OUR session) are wrong/expired — surface
      // a 401 so the client can prompt for re-entry. Same convention as
      // the presign route documented in lib/r2/errors.ts.
      throw ApiErrors.unauthorized("R2 credentials rejected");
    }
    throw err;
  }

  const bucketBasics: Array<{ name: string; createdAt: number | null }> = [];
  for (const b of raw) {
    if (typeof b.name !== "string" || b.name.length === 0) continue;
    bucketBasics.push({
      name: b.name,
      createdAt: b.creationDate ? b.creationDate.getTime() : null,
    });
  }

  const cached = await readBucketUsageCache(
    db,
    { userId: ctx.userId, connectionId: connection.id },
    bucketBasics.map((b) => b.name),
  );
  const nowMs = Date.now();
  const buckets: BucketSummary[] = bucketBasics.map((bucket) => ({
    ...bucket,
    usage: cached.get(bucket.name) ?? null,
  }));

  const refreshTargets = buckets
    .filter((bucket) => usageNeedsRefresh(bucket.usage, nowMs))
    .slice(0, BUCKET_USAGE_MAX_BUCKETS_PER_REQUEST);

  for (const bucket of refreshTargets) {
    const now = new Date();
    try {
      const usage = await summarizeBucketUsage({
        client,
        bucket: bucket.name,
        maxObjects: BUCKET_USAGE_MAX_OBJECTS_PER_BUCKET,
        maxPages: BUCKET_USAGE_MAX_PAGES_PER_BUCKET,
      });
      bucket.usage = await upsertBucketUsageSuccess(
        db,
        { userId: ctx.userId, connectionId: connection.id, bucket: bucket.name },
        usage,
        now,
      );
    } catch {
      bucket.usage = await upsertBucketUsageFailure(
        db,
        { userId: ctx.userId, connectionId: connection.id, bucket: bucket.name },
        now,
      );
    }
  }
  await touchConnectionLastUsed(db, {
    connectionId: connection.id,
    userId: ctx.userId,
    requestId: ctx.requestId,
    tag: "buckets",
  });

  return buckets;
});
