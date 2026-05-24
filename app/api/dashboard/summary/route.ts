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
// decrypt failure).
//
// Read-only → no CSRF, no audit row on success; failure to decrypt is
// audited under `security.decrypt_failed` the same way as the buckets
// route. The 60/min/user rate limit (dashboardSummaryByUser) bounds the
// cost of the 6-query fan-out — interactive refresh stays well below it.

import "server-only";

import { and, eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import {
  parseQuery,
  DashboardSummaryQuerySchema,
} from "@/lib/api/schemas";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import { asU8 } from "@/lib/db/blob";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  CryptoIntegrityError,
  decryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { listBuckets } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";
import { getDashboardSummary } from "@/lib/dashboard/summary";

export const runtime = "edge";

type SummaryEnv = DbEnv & CryptoEnv;

export const GET = withApi(
  async (req, ctx) => {
    const input = await parseQuery(req, DashboardSummaryQuerySchema);
    const env = getRequestContext().env as unknown as SummaryEnv;
    const db = getDb(env);

    const connection = await db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.id, input.connectionId),
          eq(schema.connections.userId, ctx.userId),
        ),
      )
      .get();
    if (!connection) {
      throw ApiErrors.notFound("Connection not found");
    }

    let accessKeyId: string;
    let secretAccessKey: string;
    try {
      [accessKeyId, secretAccessKey] = await Promise.all([
        decryptCredential(
          asU8(connection.accessKeyCiphertext, "dashboard/summary"),
          asU8(connection.accessKeyIv, "dashboard/summary"),
          connection.id,
          env,
        ),
        decryptCredential(
          asU8(connection.secretKeyCiphertext, "dashboard/summary"),
          asU8(connection.secretKeyIv, "dashboard/summary"),
          connection.id,
          env,
        ),
      ]);
    } catch (err) {
      await logAudit({
        userId: ctx.userId,
        connectionId: connection.id,
        op: "security.decrypt_failed",
        status: "failure",
        errorMsg:
          err instanceof CryptoIntegrityError
            ? "credential integrity check failed"
            : "credential decrypt failed",
        req,
      });
      throw ApiErrors.internal("Failed to decrypt connection credentials");
    }

    const client = makeS3Client({
      accountId: connection.accountId,
      accessKeyId,
      secretAccessKey,
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
