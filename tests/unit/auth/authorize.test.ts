// tests/unit/auth/authorize.test.ts
//
// Behavioural spec for `verifyCredentials` — the pure function that the
// NextAuth Credentials.authorize callback delegates to. Testing the function
// directly avoids spinning up the full NextAuth() runtime, which would need
// CSRF cookies, request shapes, etc. that add noise without coverage.
//
// Harness pattern mirrors tests/unit/api/totp/preflight.route.test.ts:
//   * real D1-shaped SQLite + real drizzle schema
//   * d1Facade implements the slice of D1Database that lib/api/rate-limit
//     UPSERT uses (env.DB)
//   * `getDb` is mocked so drizzle queries (totp-store + adapter) run on the
//     same better-sqlite3 instance via drizzle/better-sqlite3
//
// What this suite proves:
//   - 3-factor happy path (email + password + valid TOTP)
//   - wrong OTP / wrong password → null
//   - replay guard: same code twice → second call fails
//   - recovery code: one-shot consumption
//   - signInGrant: one-shot consumption (no password/OTP needed)
//   - verify rate-limit: 11th attempt within window returns null even with
//     correct credentials

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import {
  generateTotpSecret,
  generateTotpCode,
  base32Encode,
} from "@/lib/auth/totp";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/recovery-codes";
import { encryptCredential } from "@/lib/crypto/aes-gcm";
import type { RateLimitDb } from "@/lib/api/rate-limit";

const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(11)).toString(
  "base64",
);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;
let userId: string;
let totpSecret: Uint8Array;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { DB: d1Facade, ENCRYPTION_KEY: ENCRYPTION_KEY_B64 },
  }),
}));

vi.mock("@/lib/db/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/client")>(
    "@/lib/db/client",
  );
  return {
    ...actual,
    getDb: () => drizzleDb,
  };
});

function applyMigrations(db: SqliteDb) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
}

function makeD1Facade(db: SqliteDb): RateLimitDb {
  // Only the rate-limit UPSERT touches this facade — drizzle queries go
  // through the mocked getDb -> drizzleDb. `bind().first()` is the single
  // shape checkLimit needs.
  return {
    prepare(query: string) {
      const stmt = db.prepare(query);
      return {
        bind(...values: unknown[]) {
          return {
            async first<T = unknown>() {
              const row = stmt.get(...(values as never[])) as T | undefined;
              return row ?? null;
            },
          };
        },
      };
    },
  };
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);

  userId = ulid();
  const passwordHash = await hashPassword("correct-horse-battery");
  totpSecret = generateTotpSecret();
  const { iv, ciphertext } = await encryptCredential(
    base32Encode(totpSecret),
    userId,
    { ENCRYPTION_KEY: ENCRYPTION_KEY_B64 },
  );
  sqlite
    .prepare(
      `INSERT INTO users (id, email, password_hash, created_at, totp_enabled, totp_secret_ciphertext, totp_secret_iv)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      userId,
      "u@example.com",
      passwordHash,
      Math.floor(Date.now() / 1000),
      Buffer.from(ciphertext),
      Buffer.from(iv),
    );
});

async function importVerify() {
  // Import from the dedicated module (re-exported by lib/auth/index.ts) so
  // we avoid pulling in the full NextAuth() runtime — next-auth's top-level
  // `next/server` import is unresolvable under vitest/jsdom.
  const mod = await import("@/lib/auth/verify-credentials");
  return mod.verifyCredentials;
}

describe("verifyCredentials (authorize 的纯函数核)", () => {
  it("returns user for valid email+password+otp", async () => {
    const verify = await importVerify();
    const code = await generateTotpCode(
      totpSecret,
      Math.floor(Date.now() / 1000),
    );
    const user = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: code,
    });
    expect(user).toEqual({ id: userId, email: "u@example.com" });
  });

  it("returns null for wrong OTP", async () => {
    const verify = await importVerify();
    const user = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: "000000",
    });
    expect(user).toBeNull();
  });

  it("returns null for wrong password", async () => {
    const verify = await importVerify();
    const code = await generateTotpCode(
      totpSecret,
      Math.floor(Date.now() / 1000),
    );
    const user = await verify({
      email: "u@example.com",
      password: "bad",
      otp: code,
    });
    expect(user).toBeNull();
  });

  it("rejects replay: same code twice → second call fails", async () => {
    const verify = await importVerify();
    const code = await generateTotpCode(
      totpSecret,
      Math.floor(Date.now() / 1000),
    );
    const u1 = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: code,
    });
    expect(u1).not.toBeNull();
    const u2 = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: code,
    });
    expect(u2).toBeNull();
  });

  it("recovery code path: works once, fails on reuse", async () => {
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(c, userId)));
    for (const h of hashes) {
      sqlite
        .prepare(
          "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(ulid(), userId, h, Math.floor(Date.now() / 1000));
    }
    const verify = await importVerify();
    const u1 = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: codes[0]!,
    });
    expect(u1).not.toBeNull();
    const u2 = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: codes[0]!,
    });
    expect(u2).toBeNull();
  });

  it("signInGrant path: consumes a valid grant once, ignores password/otp", async () => {
    const grant = ulid();
    const te = new TextEncoder();
    const digest = await crypto.subtle.digest("SHA-256", te.encode(grant));
    const grantHash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    sqlite
      .prepare(
        "INSERT INTO sign_in_grants (id, user_id, grant_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        ulid(),
        userId,
        grantHash,
        Math.floor(Date.now() / 1000) + 300,
        Math.floor(Date.now() / 1000),
      );
    const verify = await importVerify();
    const u1 = await verify({
      email: "u@example.com",
      signInGrant: grant,
    });
    expect(u1).toEqual({ id: userId, email: "u@example.com" });
    // second consume fails
    const u2 = await verify({
      email: "u@example.com",
      signInGrant: grant,
    });
    expect(u2).toBeNull();
  });

  it("verify rate-limit: 11th attempt within window returns null", async () => {
    const verify = await importVerify();
    // The policy is 10/15min per user. Push 10 failing attempts then one
    // that *would* have been valid — should still fail because the limit
    // counter includes both successes and failures.
    for (let i = 0; i < 10; i++) {
      await verify({
        email: "u@example.com",
        password: "wrong",
        otp: "000000",
      });
    }
    const code = await generateTotpCode(
      totpSecret,
      Math.floor(Date.now() / 1000),
    );
    const u = await verify({
      email: "u@example.com",
      password: "correct-horse-battery",
      otp: code,
    });
    expect(u).toBeNull();
  });
});
