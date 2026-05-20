// drizzle.config.ts
//
// Drizzle Kit configuration. We use drizzle-kit only for SQL *generation*;
// migrations are applied to Cloudflare D1 by `wrangler d1 migrations apply`
// (see db:migrate:local / db:migrate:prod scripts in package.json), so the
// `driver` / `dbCredentials` fields are intentionally omitted. wrangler.toml
// declares `migrations_dir = "drizzle/migrations"`, matching the `out` here.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./drizzle/migrations",
  strict: true,
  verbose: true,
});
