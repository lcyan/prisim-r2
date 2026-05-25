// tests/unit/api/totp/enroll-complete.route.test.ts
//
// Spec for POST /api/auth/totp/enroll/complete.
//
// Pre-auth route — step 2 of TOTP enrollment. Receives { email, grant, code },
// atomically consumes the totp_enrollments row (DELETE…RETURNING), verifies
// the 6-digit code against the just-decrypted secret, then persists the secret
// to users.totp_*, mints 10 recovery codes, updates the replay guard, and
// issues a one-shot signInGrant the client carries into Auth.js sign-in.
//
// Harness mirrors enroll-begin.route.test.ts: in-memory better-sqlite3 with
// real drizzle schema; a slim D1 facade for the rate limiter's UPSERT;
// getDb mocked so route + logAudit share one drizzle instance.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import {
  generateTotpSecret,
  generateTotpCode,
  base32Encode,
} from "@/lib/auth/totp";
import { encryptCredential } from "@/lib/crypto/aes-gcm";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;
let userId: string;
let secret: Uint8Array;
let grant: string;

const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64",
);

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: () => ({
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

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../../../drizzle/migrations",
);

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

async function sha256Hex(s: string): Promise<string> {
  const te = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", te.encode(s));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);

  userId = ulid();
  sqlite
    .prepare(
      "INSERT INTO users (id, email, password_hash, created_at, totp_enabled) VALUES (?, ?, ?, ?, 0)",
    )
    .run(userId, "admin@example.com", "x", Math.floor(Date.now() / 1000));

  secret = generateTotpSecret();
  const { iv, ciphertext } = await encryptCredential(
    base32Encode(secret),
    userId,
    { ENCRYPTION_KEY: ENCRYPTION_KEY_B64 },
  );
  grant = ulid();
  const grantHash = await sha256Hex(grant);
  sqlite
    .prepare(
      "INSERT INTO totp_enrollments (id, user_id, grant_hash, secret_ciphertext, secret_iv, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      ulid(),
      userId,
      grantHash,
      Buffer.from(ciphertext),
      Buffer.from(iv),
      Math.floor(Date.now() / 1000) + 600,
      Math.floor(Date.now() / 1000),
    );
});

async function call(body: unknown, ip = "1.2.3.4") {
  const { POST } = await import(
    "@/app/api/auth/totp/enroll/complete/route"
  );
  return POST(
    new Request("https://x/api/auth/totp/enroll/complete", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/auth/totp/enroll/complete", () => {
  it("on success: enables TOTP, returns 10 recovery codes + signInGrant", async () => {
    const code = await generateTotpCode(secret, Math.floor(Date.now() / 1000));
    const res = await call({ email: "admin@example.com", grant, code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recoveryCodes: string[];
      signInGrant: string;
    };
    expect(body.recoveryCodes).toHaveLength(10);
    for (const c of body.recoveryCodes) {
      expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
    expect(body.signInGrant.length).toBeGreaterThanOrEqual(16);

    const u = sqlite
      .prepare("SELECT totp_enabled FROM users WHERE id = ?")
      .get(userId) as { totp_enabled: number };
    expect(u.totp_enabled).toBe(1);

    const r = sqlite
      .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?")
      .get(userId) as { n: number };
    expect(r.n).toBe(10);

    const g = sqlite
      .prepare("SELECT COUNT(*) AS n FROM sign_in_grants WHERE user_id = ?")
      .get(userId) as { n: number };
    expect(g.n).toBe(1);

    const e = sqlite
      .prepare("SELECT COUNT(*) AS n FROM totp_enrollments")
      .get() as { n: number };
    expect(e.n).toBe(0);
  });

  it("rejects wrong code with 400 auth.totp.invalid_code, leaves users.totp_enabled=0", async () => {
    const res = await call({
      email: "admin@example.com",
      grant,
      code: "000000",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.totp.invalid_code");

    const u = sqlite
      .prepare("SELECT totp_enabled FROM users WHERE id = ?")
      .get(userId) as { totp_enabled: number };
    expect(u.totp_enabled).toBe(0);
  });

  it("rejects invalid grant with 410 auth.totp.grant_expired", async () => {
    const code = await generateTotpCode(secret, Math.floor(Date.now() / 1000));
    const res = await call({
      email: "admin@example.com",
      grant: ulid(),
      code,
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.totp.grant_expired");
  });

  it("rejects reuse of same grant on second call", async () => {
    const code = await generateTotpCode(secret, Math.floor(Date.now() / 1000));
    const r1 = await call({ email: "admin@example.com", grant, code });
    expect(r1.status).toBe(200);
    const r2 = await call({ email: "admin@example.com", grant, code });
    expect(r2.status).toBe(410);
  });
});
