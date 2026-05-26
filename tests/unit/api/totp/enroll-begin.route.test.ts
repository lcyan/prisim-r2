// tests/unit/api/totp/enroll-begin.route.test.ts
//
// Spec for POST /api/auth/totp/enroll/begin.
//
// Pre-auth route — step 1 of TOTP enrollment. Verifies email + password
// (anti-enumeration: unknown user returns the same 401 as wrong password),
// rejects users that are already enrolled, and mints a fresh secret +
// grant. Secret is stored AES-GCM-encrypted under the user's ULID AAD;
// the grant is persisted as sha256(grant) so the plaintext lives only in
// the JSON response and the client's in-memory wizard.
//
// Harness pattern mirrors preflight.route.test.ts:
//   * real D1-shaped SQLite + real drizzle schema
//   * d1Facade implements the slice of D1Database that the rate limiter's
//     UPSERT needs; everything else goes through the drizzle instance
//   * mocks getDb so the route + logAudit both use drizzle-on-better-sqlite3.
//   * mocks qrcode → "<svg>...</svg>" stub so vitest doesn't drag in the
//     node-canvas optional dep.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import { hashPassword } from "@/lib/auth/password";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;
const userId = ulid();
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

// Avoid pulling in optional node-canvas dep under vitest.
vi.mock("qrcode", () => ({
  default: {
    toString: async () => "<svg>fake-qr</svg>",
  },
  toString: async () => "<svg>fake-qr</svg>",
}));

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../drizzle/migrations");

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

beforeEach(async () => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);

  const hash = await hashPassword("correct-horse-battery-12");
  sqlite
    .prepare(
      "INSERT INTO users (id, email, password_hash, created_at, totp_enabled) VALUES (?, ?, ?, ?, 0)",
    )
    .run(userId, "admin@example.com", hash, Math.floor(Date.now() / 1000));
});

async function call(body: unknown, ip = "1.2.3.4") {
  const { POST } = await import("@/app/api/auth/totp/enroll/begin/route");
  return POST(
    new Request("https://x/api/auth/totp/enroll/begin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/auth/totp/enroll/begin", () => {
  it("returns grant + otpauthUri + qrSvg + secretBase32 for valid creds", async () => {
    const res = await call({
      email: "admin@example.com",
      password: "correct-horse-battery-12",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grant: string;
      otpauthUri: string;
      qrSvg: string;
      secretBase32: string;
    };
    expect(body.grant.length).toBeGreaterThanOrEqual(16);
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.qrSvg).toContain("<svg");
    expect(body.secretBase32).toMatch(/^[A-Z2-7]+$/);
    const n = sqlite
      .prepare("SELECT COUNT(*) AS n FROM totp_enrollments")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("rejects wrong password with 401 auth.invalid_credentials", async () => {
    const res = await call({
      email: "admin@example.com",
      password: "wrong-password-here",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.invalid_credentials");
  });

  it("rejects unknown email with 401 auth.invalid_credentials (anti-enumeration)", async () => {
    const res = await call({
      email: "nope@example.com",
      password: "anything-goes-here",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.invalid_credentials");
  });

  it("rejects when user already enrolled with 409 auth.totp.already_enrolled", async () => {
    sqlite
      .prepare("UPDATE users SET totp_enabled = 1 WHERE email = ?")
      .run("admin@example.com");
    const res = await call({
      email: "admin@example.com",
      password: "correct-horse-battery-12",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.totp.already_enrolled");
  });

  it("writes an audit log row on success", async () => {
    await call({
      email: "admin@example.com",
      password: "correct-horse-battery-12",
    });
    const log = sqlite
      .prepare("SELECT op, status FROM audit_log ORDER BY created_at DESC LIMIT 1")
      .get() as { op: string; status: string };
    expect(log.op).toBe("auth.totp.enroll.begin");
    expect(log.status).toBe("success");
  });

  it("replaces previous enrollment row when called twice", async () => {
    await call({
      email: "admin@example.com",
      password: "correct-horse-battery-12",
    });
    await call({
      email: "admin@example.com",
      password: "correct-horse-battery-12",
    });
    const n = sqlite
      .prepare("SELECT COUNT(*) AS n FROM totp_enrollments")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});
