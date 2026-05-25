// app/api/dashboard/summary/route.ts
//
// GET /api/dashboard/summary?connectionId=<ULID>&range=7d|30d
//
// Hydrates the dashboard page: one R2 control-plane round-trip for the
// bucket count plus a parallel D1 fan-out for ops / failures / shares /
// trends / recent activity (see lib/dashboard/summary.ts for the query
// shape). Mirrors r2/buckets/route.ts for the connection-fetch + decrypt
// + listBuckets prefix because both share the "scope by user, decrypt,
// hit R2" pattern — see app/api/r2/buckets/route.ts for the comments on
// the security choices (404 not 403, AAD = connection.id, audit on
// decrypt failure). That shared prefix now lives in
// lib/r2/route-helpers.ts (resolveConnectionForR2).
//
// Read-only → no CSRF, no audit row on success; failure to decrypt is
// audited under `security.decrypt_failed` the same way as the buckets
// route. The 60/min/user rate limit (dashboardSummaryByUser) bounds the
// cost of the 6-query fan-out — interactive refresh stays well below it.

import "server-only";

import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import {
  parseQuery,
  DashboardSummaryQuerySchema,
} from "@/lib/api/schemas";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { type DbEnv } from "@/lib/db/client";
import { type CryptoEnv } from "@/lib/crypto/aes-gcm";
import { listBuckets } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { resolveConnectionForR2 } from "@/lib/r2/route-helpers";
import { getDashboardSummary } from "@/lib/dashboard/summary";

export const runtime = "edge";

type SummaryEnv = DbEnv & CryptoEnv;

export const GET = withApi(
  async (req, ctx) => {
    const input = await parseQuery(req, DashboardSummaryQuerySchema);
    const env = getRequestContext().env as unknown as SummaryEnv;

    const { db, client } = await resolveConnectionForR2({
      cid: input.connectionId,
      userId: ctx.userId,
      env,
      req,
      purpose: "dashboard/summary",
    });

    let buckets: Awaited<ReturnType<typeof listBuckets>>;
    try {
      buckets = await listBuckets({ client });
    } catch (err) {
      if (err instanceof R2CredentialError) {
        throw ApiErrors.unauthorized("R2 credentials rejected");
      }
      throw err;
    }

    return getDashboardSummary(input, {
      db,
      userId: ctx.userId,
      bucketsCount: buckets.length,
    });
  },
  {
    rateLimit: ({ ctx }) =>
      RateLimitBundles.dashboardSummaryByUser(ctx.userId),
  },
);
