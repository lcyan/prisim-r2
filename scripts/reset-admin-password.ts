// scripts/reset-admin-password.ts
//
// One-shot CLI to rotate the admin user's password WITHOUT touching the
// users row's `id` — so connections.user_id FKs stay valid and no R2
// connection rows are lost.
//
// Reads ADMIN_EMAIL + ADMIN_PASSWORD from the environment, hashes with the
// runtime's own PBKDF2 routine, and prints a single UPDATE statement you
// pipe into `wrangler d1 execute` (local or remote).
//
// Usage:
//   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='new-password-123' \
//     pnpm tsx scripts/reset-admin-password.ts | tee /tmp/reset.sql
//   pnpm wrangler d1 execute prisim-r2-db --local --file=/tmp/reset.sql

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
  if (password.length < 12) {
    console.error(
      "ERROR: ADMIN_PASSWORD must be >= 12 chars (this app is single-user; weak passwords here = compromise).",
    );
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const esc = (s: string) => s.replaceAll("'", "''");

  process.stdout.write(
    `-- Reset password for ${esc(email)} (preserves users.id and connections FKs)\n` +
      `UPDATE users SET password_hash = '${esc(hash)}' WHERE email = '${esc(email)}';\n`,
  );

  console.error(`✓ password hash prepared for ${email}`);
}

main().catch((err) => {
  console.error("reset-admin-password failed:", err);
  process.exit(1);
});
