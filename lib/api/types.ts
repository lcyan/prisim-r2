// lib/api/types.ts
//
// Public API output shapes — wire types returned by /api/*.
//
// Why this file exists:
//   The route modules under app/api/* import "server-only", which makes
//   them unsafe to import (even as types in some toolchains) from client
//   components and hooks. Centralizing the response interfaces here keeps
//   a single source of truth without forcing client code to pull in the
//   server-only boundary.
//
//   Route handlers MUST import these types instead of redefining them —
//   the typecheck will catch any drift between what the server returns
//   and what the client expects.
//
// What does NOT belong here:
//   - Zod input schemas → lib/api/schemas.ts
//   - Error shapes → lib/api/errors.ts (ApiErrorPayload)
//   - DB row types → lib/db/schema.ts (drizzle-inferred)

/**
 * Public projection of `connections` rows returned by:
 *   GET  /api/connections
 *   POST /api/connections
 *   PATCH /api/connections/[id]
 *
 * Timestamps are normalized to epoch milliseconds so the wire shape is
 * stable across runtimes (drizzle returns Date in Node, ms in some D1
 * code paths). Clients convert back to Date as needed.
 *
 * Secret material — access key ciphertext, secret key ciphertext, IVs —
 * is NEVER included. `accessKeyMasked` shows first 4 + last 4 chars only
 * (see `maskAccessKey` in schemas.ts).
 */
export interface ConnectionSummary {
  id: string;
  name: string;
  accountId: string;
  accessKeyMasked: string;
  /** Epoch ms — when the connection was created. */
  createdAt: number;
  /** Epoch ms of the last R2 op against this connection, or null if the
   *  connection has never been used (just-created or probe-only). */
  lastUsedAt: number | null;
}
