// tests/unit/api/middleware-rate-limit.test.ts
//
// Integration spec for withApi + rateLimit option. We mount the real
// checkLimit UPSERT against an in-memory better-sqlite3 (same pattern used
// by tests/unit/db/migration.test.ts), but stub the session/CSRF parts so
// the test focuses on the limiter wiring: ordering vs CSRF, Retry-After
// header propagation, bundle-ordering picks the narrower policy on denial,
// and write-aggregate trips after the per-endpoint cap.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CSRF_HEADER_NAME,
  generateCsrfToken,
  hashCsrfToken,
} from "@/lib/auth/csrf";
import { ApiErrorCode } from "@/lib/api/errors";
import {
  RateLimitBundles,
  RateLimitPolicies,
  type RateLimitDb,
} from "@/lib/api/rate-limit";

type Db = InstanceType<typeof Database>;
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");

function applyMigrations(db: Db) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) db.exec(trimmed);
    }
  }
}

/** D1-shaped facade over better-sqlite3, matching what checkLimit uses. */
function makeSqliteDb(db: Db): RateLimitDb {
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

// Per-suite singletons so the vi.mock factories can read them.
let sqlite: Db;
let fakeDb: RateLimitDb;
const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => fakeJwt.token),
}));

vi.mock("@cloudflare/next-on-pages", () => ({
  // checkLimit reaches into env.DB — return our RateLimitDb facade so the
  // real UPSERT SQL is exercised against an in-memory SQLite.
  getRequestContext: () => ({
    env: { DB: fakeDb, AUTH_SECRET: "test-secret" },
  }),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({}),
}));

vi.mock("@/lib/auth/adapter", () => ({
  createD1Adapter: () => ({
    async getSessionAndUser(token: string) {
      const row = fakeSessionStore.get(token);
      if (!row) return null;
      return {
        user: { id: row.userId, email: row.email },
        expiresAt: new Date(Date.now() + 3_600_000),
        csrfTokenHash: row.csrfTokenHash,
      };
    },
  }),
}));

// Imports MUST come after vi.mock — see middleware.test.ts for the same pattern.
import { withApi } from "@/lib/api/middleware";

async function seedSession(args: { sessionToken: string; csrfToken: string }) {
  const csrfTokenHash = await hashCsrfToken(args.csrfToken);
  fakeSessionStore.set(args.sessionToken, {
    csrfTokenHash,
    userId: "user-1",
    email: "u@example.com",
  });
  fakeJwt.token = {
    userId: "user-1",
    sessionToken: args.sessionToken,
    csrfToken: args.csrfToken,
  };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  fakeDb = makeSqliteDb(sqlite);
  fakeSessionStore.clear();
  fakeJwt.token = null;
});

async function readJson(res: Response) {
  return (await res.json()) as {
    error?: { code: string; message: string; requestId: string; details?: unknown };
  } & Record<string, unknown>;
}

describe("withApi rate-limit integration", () => {
  it("allows the first `limit` requests and 429s the next with Retry-After", async () => {
    const csrfToken = generateCsrfToken();
    await seedSession({ sessionToken: "sess-1", csrfToken });

    // Use a tiny limit so the test stays fast — the policy itself is
    // covered by tests/unit/api/rate-limit.test.ts.
    const handler = withApi(async () => ({ ok: true }), {
      rateLimit: () => [
        { key: "test:bucket", limit: 2, windowMs: 60_000 },
      ],
    });

    const makeReq = () =>
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      });

    const r1 = await handler(makeReq());
    const r2 = await handler(makeReq());
    const r3 = await handler(makeReq());

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(Number(r3.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(r3.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = await readJson(r3);
    expect(body.error?.code).toBe(ApiErrorCode.RateLimited);
    expect(body.error?.details).toEqual({ policy: "test:bucket" });
  });

  it("evaluates policies left-to-right and surfaces the first to deny", async () => {
    // Bundle order: presign(60) → write-agg(600). Tight limits so the
    // narrower one trips first and details.policy matches.
    const csrfToken = generateCsrfToken();
    await seedSession({ sessionToken: "sess-2", csrfToken });

    const handler = withApi(async () => ({ ok: true }), {
      rateLimit: ({ ctx }) => [
        { ...RateLimitPolicies.presignByUser(ctx.userId), limit: 1 },
        { ...RateLimitPolicies.writeAggregateByUser(ctx.userId), limit: 5 },
      ],
    });

    const makeReq = () =>
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      });

    await handler(makeReq()); // counts: presign=1, write=1
    const denied = await handler(makeReq()); // presign trips first
    expect(denied.status).toBe(429);
    expect((await readJson(denied)).error?.details).toEqual({
      policy: "presign:user:user-1",
    });
  });

  it("CSRF rejection happens before rate-limit, so it does not consume a bucket slot", async () => {
    const csrfToken = generateCsrfToken();
    await seedSession({ sessionToken: "sess-3", csrfToken });

    const handler = withApi(async () => ({ ok: true }), {
      rateLimit: () => [{ key: "csrf-test", limit: 1, windowMs: 60_000 }],
    });

    // Bad CSRF — should 401, NOT consume the bucket.
    const bad = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: "definitely-wrong" },
      }),
    );
    expect(bad.status).toBe(401);

    // The next two requests with valid CSRF should still see a fresh
    // bucket (1 allowed, 2nd denied) — CSRF rejection didn't burn a slot.
    const good1 = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      }),
    );
    const good2 = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      }),
    );
    expect(good1.status).toBe(200);
    expect(good2.status).toBe(429);
  });

  it("RateLimitBundles.presignByUser composes the documented two policies in order", () => {
    const bundle = RateLimitBundles.presignByUser("u1");
    expect(bundle).toEqual([
      { key: "presign:user:u1", limit: 60, windowMs: 60_000 },
      { key: "write:user:u1", limit: 600, windowMs: 60_000 },
    ]);
  });

  it("RateLimitBundles.shareCreateByUser composes the documented two policies in order", () => {
    const bundle = RateLimitBundles.shareCreateByUser("u1");
    expect(bundle).toEqual([
      { key: "share-create:user:u1", limit: 30, windowMs: 60_000 },
      { key: "write:user:u1", limit: 600, windowMs: 60_000 },
    ]);
  });

  it("GET requests skip CSRF but still hit rate-limit when configured", async () => {
    await seedSession({ sessionToken: "sess-4", csrfToken: generateCsrfToken() });
    const handler = withApi(async () => ({ ok: true }), {
      rateLimit: () => [{ key: "get-test", limit: 1, windowMs: 60_000 }],
    });

    const r1 = await handler(new Request("https://x/", { method: "GET" }));
    const r2 = await handler(new Request("https://x/", { method: "GET" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });
});
