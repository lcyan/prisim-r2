// app/api/connections/route.ts
//
// CRUD root for R2 connections: GET (list, masked) and POST (create).
//
// Security invariants in play (CLAUDE.md §Security Invariants):
//   * Credentials are AES-GCM encrypted at rest. The plaintext access key
//     pair flows in via POST body → R2 probe → encryptCredential → blob
//     columns. It NEVER round-trips back to the client.
//   * GET returns ONLY masked / non-secret columns. We don't even SELECT
//     the ciphertext/iv blobs, so a future field that accidentally returns
//     `connection.*` cannot leak them.
//   * Each write step goes through audit_log: attempt (validate failure
//     OR R2 probe failure) → success. Reads are not audited (high volume,
//     no security-relevant info).
//
// Request pipeline (provided by withApi):
//   requestId → requireSession → requireCsrf(POST) → rateLimit(POST)
//             → this handler → toErrorResponse

import "server-only";

import { eq } from "drizzle-orm";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { ulid } from "ulid";

import { withApi } from "@/lib/api/middleware";
import { ApiErrors } from "@/lib/api/errors";
import { RateLimitBundles } from "@/lib/api/rate-limit";
import {
  parseJson,
  ConnectionsCreateSchema,
  maskAccessKey,
} from "@/lib/api/schemas";
import type { ConnectionSummary } from "@/lib/api/types";
import { getDb, schema, type DbEnv } from "@/lib/db/client";
import {
  encryptCredential,
  type CryptoEnv,
} from "@/lib/crypto/aes-gcm";
import { makeS3Client } from "@/lib/r2/client";
import { listBuckets } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

export const runtime = "edge";

type ConnectionsEnv = DbEnv & CryptoEnv;

// ConnectionSummary is now defined in lib/api/types.ts so the hooks layer
// (which runs in the browser) can type its payloads without crossing the
// server-only boundary. The interface is re-exported as a convenience for
// any consumer that already imports from this route's module.
export type { ConnectionSummary };

function rowToSummary(row: {
  id: string;
  name: string;
  accountId: string;
  accessKeyMasked: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}): ConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    accessKeyMasked: row.accessKeyMasked,
    // Date → epoch ms keeps the JSON wire shape stable across runtimes
    // (drizzle's `mode: timestamp` returns Date in Node, but D1 stores
    // seconds — the unmarshalling is consistent because drizzle does it,
    // we just normalize the output once here).
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
  };
}

// ─── GET /api/connections ───────────────────────────────────────────────
//
// Returns the authenticated user's connections, projecting ONLY safe
// columns. The select() column list is exhaustive on purpose — adding a
// new secret column to the schema and forgetting to update this list
// would NOT leak, because the projection is explicit (not `select()` star).

export const GET = withApi(async (_req, ctx) => {
  const env = getRequestContext().env as unknown as ConnectionsEnv;
  const db = getDb(env);

  const rows = await db
    .select({
      id: schema.connections.id,
      name: schema.connections.name,
      accountId: schema.connections.accountId,
      accessKeyMasked: schema.connections.accessKeyMasked,
      createdAt: schema.connections.createdAt,
      lastUsedAt: schema.connections.lastUsedAt,
    })
    .from(schema.connections)
    .where(eq(schema.connections.userId, ctx.userId))
    .all();

  return rows.map(rowToSummary);
});

// ─── POST /api/connections ──────────────────────────────────────────────
//
// Flow:
//   1. Zod parse (strict object) → 400 validation.invalid on schema error
//   2. Mint connection id (ULID) up-front so it can serve as AES-GCM AAD
//   3. Probe the supplied creds with listBuckets() ONCE
//        * R2CredentialError → 400 connection.invalid_credentials
//          (failure audit row, NO key fragments echoed back)
//        * Other R2 upstream errors → propagate as 5xx (mapR2Error already
//          stripped the inner message; withApi will collapse to 500)
//   4. Encrypt access + secret with AAD = connection.id
//   5. INSERT row (masked + endpoint + ciphertexts)
//   6. Audit connection.create success
//   7. Return ConnectionSummary (never the ciphertext / iv / plaintext)

export const POST = withApi(
  async (req, ctx) => {
    const input = await parseJson(req, ConnectionsCreateSchema);
    const env = getRequestContext().env as unknown as ConnectionsEnv;
    const db = getDb(env);
    const id = ulid();

    // Step 1: probe R2 with the supplied keys. We MUST do this before
    // persisting — saving bad keys would let a user fill the DB with
    // unusable rows and (worse) audit a meaningful-looking success.
    const client = makeS3Client({
      accountId: input.accountId,
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    });
    try {
      await listBuckets({ client });
    } catch (err) {
      // Audit the failed attempt. user_id is set; connection_id is NULL
      // because we haven't inserted a row (and never will for this id).
      await logAudit({
        userId: ctx.userId,
        connectionId: null,
        op: "connection.create",
        status: "failure",
        errorMsg:
          err instanceof R2CredentialError
            ? "r2_credential_rejected"
            : "r2_probe_failed",
        req,
      });
      if (err instanceof R2CredentialError) {
        // Surface the domain-specific code so the UI can highlight the
        // access-key field rather than logging the session out.
        throw ApiErrors.connectionInvalidCredentials();
      }
      // Generic upstream failure (throttling, transient network, …). Let
      // withApi map to 500 via the default branch — the user can retry
      // without re-entering their keys.
      throw err;
    }

    // Step 2: encrypt both halves of the pair. AAD = connection.id binds
    // each ciphertext to this row; a copy into another row will fail tag
    // verification at decrypt time (CryptoIntegrityError).
    const [accessEnc, secretEnc] = await Promise.all([
      encryptCredential(input.accessKeyId, id, env),
      encryptCredential(input.secretAccessKey, id, env),
    ]);

    const endpoint = `https://${input.accountId}.r2.cloudflarestorage.com`;
    const accessKeyMasked = maskAccessKey(input.accessKeyId);
    const createdAt = new Date();

    await db.insert(schema.connections).values({
      id,
      userId: ctx.userId,
      name: input.name,
      accountId: input.accountId,
      endpoint,
      accessKeyMasked,
      accessKeyCiphertext: Buffer.from(accessEnc.ciphertext),
      accessKeyIv: Buffer.from(accessEnc.iv),
      secretKeyCiphertext: Buffer.from(secretEnc.ciphertext),
      secretKeyIv: Buffer.from(secretEnc.iv),
      createdAt,
      lastUsedAt: null,
    });

    await logAudit({
      userId: ctx.userId,
      connectionId: id,
      op: "connection.create",
      status: "success",
      req,
    });

    const summary: ConnectionSummary = {
      id,
      name: input.name,
      accountId: input.accountId,
      accessKeyMasked,
      createdAt: createdAt.getTime(),
      lastUsedAt: null,
    };

    // 201 Created — fresh resource, conventional REST status. The Location
    // header points at the [id] sub-route so clients that follow it land
    // on the same record's PATCH/DELETE endpoint.
    return new Response(JSON.stringify(summary), {
      status: 201,
      headers: {
        "content-type": "application/json",
        location: `/api/connections/${id}`,
      },
    });
  },
  {
    // Connection create is a write op. It's not high-volume enough to
    // warrant its own per-endpoint cap (a user creating 600 connections
    // in a minute is doing something pathological), so we rely on the
    // user-wide write aggregate budget.
    rateLimit: ({ ctx }) => RateLimitBundles.writeOnlyByUser(ctx.userId),
  },
);
