// lib/db/client.ts
//
// Drizzle factory bound to the Cloudflare D1 binding declared in wrangler.toml
// (`[[d1_databases]] binding = "DB"`). API routes call `getDb(env)` once per
// request; the client itself is cheap and statelessly wraps env.DB, so we don't
// memoize across requests.
//
// `import "server-only"` keeps this module out of any Client Component bundle.

import "server-only";

import { drizzle } from "drizzle-orm/d1";
import { schema } from "./schema";

/**
 * Minimal Env shape for D1 access. The full Cloudflare Pages Env (with the
 * other bindings — KV, R2 control, secrets) is composed at the route layer.
 */
export interface DbEnv {
  DB: D1Database;
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Build a Drizzle client bound to the D1 binding.
 *
 * Usage in an edge route handler:
 *
 *   import { getCloudflareContext } from "@opennextjs/cloudflare";
 *   import { getDb } from "@/lib/db/client";
 *
 *   export async function GET() {
 *     const db = getDb(getCloudflareContext().env as unknown as DbEnv);
 *     const users = await db.select().from(schema.users).all();
 *     return Response.json(users);
 *   }
 */
export function getDb(env: DbEnv): Db {
  return drizzle(env.DB, { schema });
}

// Re-export schema so callers can do `import { schema } from "@/lib/db/client"`
// instead of pulling from two places.
export { schema } from "./schema";
