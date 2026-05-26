// tests/unit/api/totp/preflight.route.test.ts
//
// Spec for POST /api/auth/totp/preflight.
//
// Pre-auth endpoint that tells the login page whether an email is already
// enrolled in TOTP. The contract is enumeration-safe: unknown email and
// known-but-unenrolled email both return { enrolled: false }, only a known
// AND enrolled user returns { enrolled: true }.
//
// Harness pattern mirrors connections-route.test.ts:
//   * real D1-shaped SQLite + real drizzle schema
//   * d1Facade implements just the slice of D1Database that drizzle/d1 needs
//     for these reads, plus the slice that lib/api/rate-limit's UPSERT uses
//   * mocks getDb so the route uses a drizzle-on-better-sqlite3 instance —
//     the rate limiter still goes through env.DB (the d1Facade).
//
// What this suite proves:
//   - unknown email → { enrolled: false }, no leak
//   - existing-not-enrolled → { enrolled: false }
//   - existing-enrolled → { enrolled: true }
//   - malformed email → 400 validation.invalid
//   - 11th call from same IP in 5 min → 429

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: () => ({ env: { DB: d1Facade } }),
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
  // Only the rate-limit UPSERT goes through this facade (drizzle queries use
  // drizzleDb directly via the getDb mock above). `bind().first()` is the
  // single shape checkLimit needs.
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

beforeEach(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);
});

async function callPreflight(body: unknown, ip = "1.2.3.4") {
  const { POST } = await import("@/app/api/auth/totp/preflight/route");
  return POST(
    new Request("https://x/api/auth/totp/preflight", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

function seedUser(opts: { email: string; totpEnabled: boolean }) {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, password_hash, created_at, totp_enabled)
       VALUES (?, ?, 'h', ?, ?)`,
    )
    .run(ulid(), opts.email, Math.floor(Date.now() / 1000), opts.totpEnabled ? 1 : 0);
}

describe("POST /api/auth/totp/preflight", () => {
  it("returns { enrolled: false } for non-existent email (anti-enumeration)", async () => {
    const res = await callPreflight({ email: "nope@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enrolled: false });
  });

  it("returns { enrolled: false } for existing user not yet enrolled", async () => {
    seedUser({ email: "u@example.com", totpEnabled: false });
    const res = await callPreflight({ email: "u@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enrolled: false });
  });

  it("returns { enrolled: true } for an enrolled user", async () => {
    seedUser({ email: "e@example.com", totpEnabled: true });
    const res = await callPreflight({ email: "e@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enrolled: true });
  });

  it("rejects malformed email with 400 validation.invalid", async () => {
    const res = await callPreflight({ email: "not-an-email" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation.invalid");
  });

  it("rate-limits by IP after 10 calls in 5 min", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await callPreflight({ email: "x@example.com" });
      expect(r.status).toBe(200);
    }
    const r11 = await callPreflight({ email: "x@example.com" });
    expect(r11.status).toBe(429);
  });
});
