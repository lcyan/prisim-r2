// tests/unit/api/rate-limit.test.ts
//
// Spec for lib/api/rate-limit.checkLimit. We back the RateLimitDb interface
// with an in-memory better-sqlite3 instance (the migration test already
// applies the full schema this way), so the test exercises the *real*
// UPSERT SQL — a typo in the statement string would be caught here, not in
// staging.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  checkLimit,
  getClientIp,
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

/** Adapt better-sqlite3's sync API to the D1-shaped `prepare().bind().first()`
 *  chain that checkLimit expects. We support exactly the methods checkLimit
 *  calls — no need to imitate the full D1Database surface. */
function makeSqliteAdapter(db: Db): RateLimitDb {
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

describe("checkLimit", () => {
  let sqlite: Db;
  let db: RateLimitDb;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    applyMigrations(sqlite);
    db = makeSqliteAdapter(sqlite);
  });

  it("allows the first `limit` calls and blocks the (limit+1)-th", async () => {
    const opts = { db, key: "t:1", limit: 3, windowMs: 60_000, now: 1_000 };
    for (let i = 1; i <= 3; i++) {
      const r = await checkLimit(opts);
      expect(r.ok).toBe(true);
      expect(r.count).toBe(i);
      expect(r.retryAfter).toBeUndefined();
    }
    const denied = await checkLimit(opts);
    expect(denied.ok).toBe(false);
    expect(denied.count).toBe(4);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("returns Retry-After in whole seconds, computed from window remaining", async () => {
    const start = 10_000;
    // Burn through the limit at t=start.
    for (let i = 0; i < 3; i++) {
      await checkLimit({
        db,
        key: "t:2",
        limit: 2,
        windowMs: 60_000,
        now: start,
      });
    }
    // 45s in — 15s should remain.
    const denied = await checkLimit({
      db,
      key: "t:2",
      limit: 2,
      windowMs: 60_000,
      now: start + 45_000,
    });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfter).toBe(15);
  });

  it("resets the bucket when the window has expired", async () => {
    const opts = { db, key: "t:3", limit: 2, windowMs: 1_000 };
    await checkLimit({ ...opts, now: 0 });
    await checkLimit({ ...opts, now: 0 });
    const blocked = await checkLimit({ ...opts, now: 0 });
    expect(blocked.ok).toBe(false);

    // Advance past the window — counter must reset to 1 and unblock.
    const reset = await checkLimit({ ...opts, now: 1_001 });
    expect(reset.ok).toBe(true);
    expect(reset.count).toBe(1);
    expect(reset.windowStart).toBe(1_001);
  });

  it("Retry-After clamps to at least 1 second at the very edge", async () => {
    // limit=1, windowMs=500. First call consumed; second call at t=499 has
    // 1ms remaining — Math.ceil(1/1000) is 1.
    await checkLimit({ db, key: "t:4", limit: 1, windowMs: 500, now: 0 });
    const denied = await checkLimit({
      db,
      key: "t:4",
      limit: 1,
      windowMs: 500,
      now: 499,
    });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfter).toBe(1);
  });

  it("isolates buckets by key — different keys do not share counts", async () => {
    const a = await checkLimit({
      db,
      key: "user:a",
      limit: 1,
      windowMs: 60_000,
      now: 0,
    });
    const b = await checkLimit({
      db,
      key: "user:b",
      limit: 1,
      windowMs: 60_000,
      now: 0,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it("100 concurrent calls increment the counter exactly 100 times", async () => {
    // The real D1 worker serializes statements per database; better-sqlite3
    // is synchronous so Promise.all here is essentially sequential. The test
    // still proves the UPSERT semantics (no lost updates from CASE branch
    // misordering) — true distributed concurrency is the database's job.
    const opts = {
      db,
      key: "concurrent",
      limit: 1_000_000,
      windowMs: 60_000,
      now: 0,
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => checkLimit(opts)),
    );
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});

describe("RateLimitPolicies", () => {
  it("produces the exact key formats and limits from PRD §6", () => {
    expect(RateLimitPolicies.loginByIp("1.2.3.4")).toEqual({
      key: "login:ip:1.2.3.4",
      limit: 10,
      windowMs: 5 * 60 * 1000,
    });
    expect(RateLimitPolicies.presignByUser("u1")).toEqual({
      key: "presign:user:u1",
      limit: 60,
      windowMs: 60 * 1000,
    });
    expect(RateLimitPolicies.shareCreateByUser("u1")).toEqual({
      key: "share-create:user:u1",
      limit: 30,
      windowMs: 60 * 1000,
    });
    expect(RateLimitPolicies.writeAggregateByUser("u1")).toEqual({
      key: "write:user:u1",
      limit: 600,
      windowMs: 60 * 1000,
    });
  });
});

describe("getClientIp", () => {
  it("prefers cf-connecting-ip when present", () => {
    const req = new Request("https://x/", {
      headers: {
        "cf-connecting-ip": "203.0.113.5",
        "x-forwarded-for": "10.0.0.1",
      },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to the first x-forwarded-for hop", () => {
    const req = new Request("https://x/", {
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1, 10.0.0.2" },
    });
    expect(getClientIp(req)).toBe("198.51.100.7");
  });

  it("returns 'unknown' when no IP header is present", () => {
    expect(getClientIp(new Request("https://x/"))).toBe("unknown");
  });
});
