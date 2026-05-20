// tests/unit/db/migration.test.ts
//
// Run the generated drizzle migration against an in-memory SQLite database
// (better-sqlite3) and assert all expected tables + indexes exist, plus a
// users-row round-trip works. This is the regression test for subtasks 3.2–3.4
// — if drizzle schema changes silently drop a column or rename an index, this
// test fails before the change ever reaches D1.

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

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

describe("D1 migration 0000_init", () => {
  let db: Db;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
  });

  it("creates all five tables", () => {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([
      "audit_log",
      "connections",
      "sessions",
      "shares",
      "users",
    ]);
  });

  it("creates all required indexes", () => {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("idx_connections_user")).toBe(true);
    expect(names.has("idx_shares_user_active")).toBe(true);
    expect(names.has("idx_audit_user_time")).toBe(true);
    expect(names.has("users_email_unique")).toBe(true);
  });

  it("declares foreign keys with the expected ON DELETE behavior", () => {
    type FkRow = {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    };
    const fks = db
      .prepare(
        `SELECT m.name AS "table", p.[from] AS "from", p.[to] AS "to", p.on_delete
         FROM sqlite_master m
         JOIN pragma_foreign_key_list(m.name) p
         WHERE m.type = 'table'`,
      )
      .all() as FkRow[];
    const find = (table: string, from: string) =>
      fks.find((f) => f.table === table && f.from === from);

    expect(find("connections", "user_id")?.on_delete).toBe("CASCADE");
    expect(find("shares", "user_id")?.on_delete).toBe("CASCADE");
    expect(find("shares", "connection_id")?.on_delete).toBe("CASCADE");
    expect(find("sessions", "user_id")?.on_delete).toBe("CASCADE");
    expect(find("audit_log", "user_id")?.on_delete).toBe("SET NULL");
    expect(find("audit_log", "connection_id")?.on_delete).toBe("SET NULL");
  });

  it("round-trips a users row", () => {
    const id = ulid();
    const email = `${id.toLowerCase()}@test.local`;
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, email, "pbkdf2$test$hash", Math.floor(Date.now() / 1000));

    const row = db
      .prepare(
        `SELECT id, email, password_hash, external_id FROM users WHERE id = ?`,
      )
      .get(id) as {
      id: string;
      email: string;
      password_hash: string;
      external_id: string | null;
    };

    expect(row.id).toBe(id);
    expect(row.email).toBe(email);
    expect(row.password_hash).toBe("pbkdf2$test$hash");
    expect(row.external_id).toBeNull();
  });

  it("rejects a second user with the same email (unique constraint)", () => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES (?, 'dup@test.local', 'h', ?)`,
    ).run(ulid(), Math.floor(Date.now() / 1000));

    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, email, password_hash, created_at)
           VALUES (?, 'dup@test.local', 'h', ?)`,
        )
        .run(ulid(), Math.floor(Date.now() / 1000)),
    ).toThrowError(/UNIQUE/);
  });

  it("cascades deletes from users to connections and sessions", () => {
    const userId = ulid();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', ?)`,
    ).run(userId, `${userId}@cascade.test`, now);
    db.prepare(
      `INSERT INTO connections
       (id, user_id, name, account_id, endpoint, access_key_masked,
        access_key_ciphertext, access_key_iv, secret_key_ciphertext, secret_key_iv, created_at)
       VALUES (?, ?, 'c', 'a', 'e', 'm', ?, ?, ?, ?, ?)`,
    ).run(
      ulid(),
      userId,
      Buffer.from([1]),
      Buffer.from([2]),
      Buffer.from([3]),
      Buffer.from([4]),
      now,
    );
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, 'th', ?, ?)`,
    ).run(ulid(), userId, now + 3600, now);

    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);

    const connCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM connections WHERE user_id = ?`)
        .get(userId) as { c: number }
    ).c;
    const sessCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?`)
        .get(userId) as { c: number }
    ).c;
    expect(connCount).toBe(0);
    expect(sessCount).toBe(0);
  });
});
