// tests/unit/dashboard/summary.test.ts
//
// Integration test: real better-sqlite3 backing drizzle, populated with
// audit_log + shares rows of known shape, then asserts the values
// getDashboardSummary returns.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema as realSchema } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { getDashboardSummary } from "@/lib/dashboard/summary";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");

let sqlite: InstanceType<typeof Database>;
let db: Db;
const userId = ulid();
const connectionId = ulid();

function applyMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) sqlite.exec(trimmed);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  // Cast: better-sqlite3 drizzle and D1 drizzle share the same row shapes
  // for our schema; the production type is D1's so we use it here too.
  db = drizzleSqlite(sqlite, { schema: realSchema }) as unknown as Db;
  applyMigrations();
  const nowSec = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(userId, "u@x", "h", nowSec);
  sqlite
    .prepare(
      "INSERT INTO connections (id, user_id, name, account_id, endpoint, access_key_masked, access_key_ciphertext, access_key_iv, secret_key_ciphertext, secret_key_iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      connectionId,
      userId,
      "prod-main",
      "x",
      "y",
      "z",
      Buffer.alloc(1),
      Buffer.alloc(12),
      Buffer.alloc(1),
      Buffer.alloc(12),
      nowSec,
    );
});

describe("getDashboardSummary", () => {
  it("empty audit log → zeros, opsByDay padded to range length", async () => {
    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 5 },
    );
    expect(summary.bucketsCount).toBe(5);
    expect(summary.ops.count).toBe(0);
    expect(summary.ops.previousCount).toBe(0);
    expect(summary.failures.count).toBe(0);
    expect(summary.failures.ratePct).toBe(0);
    expect(summary.opsByDay).toHaveLength(30);
    expect(summary.opsByType).toEqual([]);
    expect(summary.recentActivity).toEqual([]);
    expect(summary.shares.active).toBe(0);
    expect(summary.shares.expiring7d).toBe(0);
  });

  it("counts ops within range, excludes older rows", async () => {
    const now = Date.now();
    const insert = sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, connection_id, op, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // 3 rows within last 30d
    for (let i = 0; i < 3; i++) {
      insert.run(
        ulid(),
        userId,
        connectionId,
        "upload.create",
        "success",
        Math.floor((now - 86_400_000) / 1000),
      );
    }
    // 1 row 40 days ago (out of range)
    insert.run(
      ulid(),
      userId,
      connectionId,
      "upload.create",
      "success",
      Math.floor((now - 40 * 86_400_000) / 1000),
    );

    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.ops.count).toBe(3);
  });

  it("counts failures separately and computes rate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, connection_id, op, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      ulid(),
      userId,
      connectionId,
      "object.delete",
      "success",
      nowSec,
    );
    insert.run(
      ulid(),
      userId,
      connectionId,
      "object.delete",
      "failure",
      nowSec,
    );
    insert.run(
      ulid(),
      userId,
      connectionId,
      "object.delete",
      "failure",
      nowSec,
    );

    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.ops.count).toBe(3);
    expect(summary.failures.count).toBe(2);
    expect(summary.failures.ratePct).toBeCloseTo((2 / 3) * 100, 1);
  });

  it("opsByType orders descending by count", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO audit_log (id, user_id, connection_id, op, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 5; i++)
      insert.run(
        ulid(),
        userId,
        connectionId,
        "upload.create",
        "success",
        nowSec,
      );
    for (let i = 0; i < 2; i++)
      insert.run(
        ulid(),
        userId,
        connectionId,
        "object.delete",
        "success",
        nowSec,
      );
    for (let i = 0; i < 9; i++)
      insert.run(
        ulid(),
        userId,
        connectionId,
        "presign.get",
        "success",
        nowSec,
      );

    const summary = await getDashboardSummary(
      { connectionId, range: "7d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.opsByType[0]).toEqual({ op: "presign.get", count: 9 });
    expect(summary.opsByType[1]).toEqual({ op: "upload.create", count: 5 });
    expect(summary.opsByType[2]).toEqual({ op: "object.delete", count: 2 });
  });

  it("shares aggregate: active + expiring within 7d", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(
      "INSERT INTO shares (id, user_id, connection_id, bucket, object_key, url_hash, ttl_seconds, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // expires in 3 days → counts both active and expiring7d
    insert.run(
      ulid(),
      userId,
      connectionId,
      "b",
      "k",
      "h",
      3600,
      nowSec + 3 * 86400,
      nowSec,
    );
    // expires in 10 days → active, NOT expiring7d
    insert.run(
      ulid(),
      userId,
      connectionId,
      "b",
      "k2",
      "h",
      3600,
      nowSec + 10 * 86400,
      nowSec,
    );
    // already expired → counts neither
    insert.run(
      ulid(),
      userId,
      connectionId,
      "b",
      "k3",
      "h",
      3600,
      nowSec - 86400,
      nowSec - 86400 * 2,
    );

    const summary = await getDashboardSummary(
      { connectionId, range: "30d" },
      { db, userId, bucketsCount: 0 },
    );
    expect(summary.shares.active).toBe(2);
    expect(summary.shares.expiring7d).toBe(1);
  });
});
