// scripts/seed-admin.ts
//
// One-shot CLI to provision the single admin user. Reads ADMIN_EMAIL and
// ADMIN_PASSWORD from the environment, hashes the password with the same
// PBKDF2 routine the runtime uses, then prints the SQL you can pipe into
// wrangler d1 execute (local or remote).
//
// We deliberately do NOT shell out to wrangler from here. Doing so would
// (a) require escaping a `$`-laden hash through three layers of quoting,
// and (b) couple the secret to whatever wrangler env this script happens
// to inherit. Printing the SQL keeps the destination explicit.
//
// Usage:
//   ADMIN_EMAIL=me@example.com ADMIN_PASSWORD='hunter2' \
//     pnpm tsx scripts/seed-admin.ts | tee /tmp/seed.sql
//   wrangler d1 execute prisim-r2-db --local --file=/tmp/seed.sql
//   # or --remote for the deployed DB

import { ulid } from "ulid";
import { hashPassword } from "../lib/auth/password";

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "ERROR: set ADMIN_EMAIL and ADMIN_PASSWORD in the environment.",
    );
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("ERROR: ADMIN_EMAIL doesn't look like an email.");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error(
      "ERROR: ADMIN_PASSWORD must be >= 12 chars (this app is single-user; weak passwords here = compromise).",
    );
    process.exit(1);
  }

  const id = ulid();
  const hash = await hashPassword(password);
  const createdAt = Math.floor(Date.now() / 1000);

  // SQL string literal — sqlite uses single quotes for strings and '' to
  // escape an embedded single quote. PBKDF2 hashes only contain
  // base64 + '$' so no escaping needed, but we escape defensively anyway.
  const esc = (s: string) => s.replaceAll("'", "''");

  process.stdout.write(
    `-- Seed admin: ${esc(email)}\n` +
      `INSERT INTO users (id, email, password_hash, created_at)\n` +
      `VALUES ('${id}', '${esc(email)}', '${esc(hash)}', ${createdAt});\n`,
  );

  console.error(`✓ admin row prepared`);
  console.error(`  id:    ${id}`);
  console.error(`  email: ${email}`);
  console.error(
    `  pipe to:  wrangler d1 execute prisim-r2-db --local --command "...sql..."`,
  );
}

main().catch((err) => {
  console.error("seed-admin failed:", err);
  process.exit(1);
});
