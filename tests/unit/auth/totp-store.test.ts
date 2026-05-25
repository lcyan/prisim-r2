// tests/unit/auth/totp-store.test.ts
//
// Behavioural spec for lib/auth/totp-store.ts. Uses the same pattern as
// other db-touching tests in this repo: an in-memory better-sqlite3 db
// + a drizzle/better-sqlite3 client, with the project's real migrations
// applied so the schema matches what D1 will see in prod.
//
// Coverage:
//   enrollments (3): create→consume round-trip; consume fails after grant
//     mismatch; consume fails after TTL expiry.
//   recovery codes (1): insert N codes, consume one twice (second consume
//     returns false), count reports remaining unconsumed.
//   replay guard (1): get returns null, upsert inserts, second upsert
//     updates lastStep in place (single row per user).
//   sign-in grants (1): create→consume returns userId; second consume
//     returns null (single-use); consume after TTL returns null.
//   upsertUserTotp (1): flips totp_enabled, stores ciphertext+iv, sets
//     totpConfirmedAt.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { schema } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import {
  countActiveRecoveryCodes,
  consumeEnrollment,
  consumeRecoveryCode,
  consumeSignInGrant,
  createEnrollment,
  createSignInGrant,
  getReplayGuardStep,
  getUserTotpRow,
  insertRecoveryCodesForUser,
  upsertReplayGuard,
  upsertUserTotp,
} from "@/lib/auth/totp-store";

type SqliteDb = InstanceType<typeof Database>;
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");

function applyMigrations(db: SqliteDb) {
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

let sqlite: SqliteDb;
let db: Db;

function seedUser(): string {
  const userId = ulid();
  sqlite
    .prepare(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES (?, ?, 'h', ?)`,
    )
    .run(userId, `${userId}@test.local`, Math.floor(Date.now() / 1000));
  return userId;
}

beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  // Cast: drizzle/better-sqlite3 produces the same surface as drizzle/d1 for
  // the queries we use here (query/insert/update/delete/select/returning).
  // reason: tests run on node sqlite, not workers D1.
  db = drizzleSqlite(sqlite, { schema }) as unknown as Db;
});

beforeEach(() => {
  // Start each test from a clean slate so row order/uniqueness checks are
  // deterministic.
  sqlite.exec("DELETE FROM sign_in_grants");
  sqlite.exec("DELETE FROM totp_replay_guard");
  sqlite.exec("DELETE FROM recovery_codes");
  sqlite.exec("DELETE FROM totp_enrollments");
  sqlite.exec("DELETE FROM users");
});

describe("enrollment grants", () => {
  it("create + consume round-trips ciphertext + iv exactly once", async () => {
    const userId = seedUser();
    const ciphertext = new Uint8Array([1, 2, 3, 4]);
    const iv = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    await createEnrollment(db, {
      userId,
      grant: "grant-abc",
      secretCiphertext: ciphertext,
      secretIv: iv,
      ttlMs: 60_000,
    });

    const consumed = await consumeEnrollment(db, {
      userId,
      grant: "grant-abc",
    });
    expect(consumed).not.toBeNull();
    expect(Array.from(consumed!.secretCiphertext)).toEqual([1, 2, 3, 4]);
    expect(Array.from(consumed!.secretIv)).toEqual([
      9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
    ]);

    // Second consume must fail — row was deleted.
    const second = await consumeEnrollment(db, {
      userId,
      grant: "grant-abc",
    });
    expect(second).toBeNull();
  });

  it("rejects when the grant string does not match the stored hash", async () => {
    const userId = seedUser();
    await createEnrollment(db, {
      userId,
      grant: "the-real-grant",
      secretCiphertext: new Uint8Array([1]),
      secretIv: new Uint8Array([2]),
      ttlMs: 60_000,
    });

    const consumed = await consumeEnrollment(db, {
      userId,
      grant: "wrong-grant",
    });
    expect(consumed).toBeNull();

    // The valid grant must still work — wrong attempt should NOT delete it.
    const good = await consumeEnrollment(db, {
      userId,
      grant: "the-real-grant",
    });
    expect(good).not.toBeNull();
  });

  it("rejects an expired enrollment grant (ttl elapsed)", async () => {
    const userId = seedUser();
    await createEnrollment(db, {
      userId,
      grant: "stale-grant",
      secretCiphertext: new Uint8Array([7]),
      secretIv: new Uint8Array([8]),
      // negative ttl → expires_at is already in the past.
      ttlMs: -1_000,
    });
    const consumed = await consumeEnrollment(db, {
      userId,
      grant: "stale-grant",
    });
    expect(consumed).toBeNull();
  });
});

describe("recovery codes", () => {
  it("insert N hashes, consume one, count tracks remaining unconsumed", async () => {
    const userId = seedUser();
    const hashes = ["h0", "h1", "h2", "h3", "h4"];
    await insertRecoveryCodesForUser(db, { userId, hashes });

    expect(await countActiveRecoveryCodes(db, userId)).toBe(5);

    // First consume returns true.
    expect(
      await consumeRecoveryCode(db, { userId, hash: "h2" }),
    ).toBe(true);
    expect(await countActiveRecoveryCodes(db, userId)).toBe(4);

    // Same code consumed again → false (already used).
    expect(
      await consumeRecoveryCode(db, { userId, hash: "h2" }),
    ).toBe(false);
    expect(await countActiveRecoveryCodes(db, userId)).toBe(4);

    // Unknown hash → false.
    expect(
      await consumeRecoveryCode(db, { userId, hash: "nope" }),
    ).toBe(false);

    // Re-insert replaces the set (delete-then-insert semantics).
    await insertRecoveryCodesForUser(db, { userId, hashes: ["a", "b"] });
    expect(await countActiveRecoveryCodes(db, userId)).toBe(2);
  });
});

describe("replay guard", () => {
  it("get returns null when missing; upsert inserts then updates in place", async () => {
    const userId = seedUser();
    expect(await getReplayGuardStep(db, userId)).toBeNull();

    await upsertReplayGuard(db, { userId, step: 1234 });
    expect(await getReplayGuardStep(db, userId)).toBe(1234);

    await upsertReplayGuard(db, { userId, step: 5678 });
    expect(await getReplayGuardStep(db, userId)).toBe(5678);

    // Exactly one row per user (PK guarantees this; assertion is a witness).
    const rows = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM totp_replay_guard WHERE user_id = ?`)
      .get(userId) as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe("sign-in grants", () => {
  it("create + consume returns userId once; subsequent consumes return null", async () => {
    const userId = seedUser();
    await createSignInGrant(db, {
      userId,
      grant: "signin-grant-xyz",
      ttlMs: 60_000,
    });

    expect(await consumeSignInGrant(db, "signin-grant-xyz")).toBe(userId);
    expect(await consumeSignInGrant(db, "signin-grant-xyz")).toBeNull();
    expect(await consumeSignInGrant(db, "unrelated")).toBeNull();

    // Expired grant is not consumable.
    await createSignInGrant(db, {
      userId,
      grant: "expired-grant",
      ttlMs: -1_000,
    });
    expect(await consumeSignInGrant(db, "expired-grant")).toBeNull();
  });
});

describe("upsertUserTotp", () => {
  it("flips totp_enabled, stores ciphertext+iv, sets totp_confirmed_at", async () => {
    const userId = seedUser();
    // Pre-state: TOTP disabled, secret columns null.
    const before = await getUserTotpRow(db, userId);
    expect(before).not.toBeNull();
    expect(before!.totpEnabled).toBe(false);
    expect(before!.secretCiphertext).toBeNull();
    expect(before!.secretIv).toBeNull();

    const ciphertext = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const iv = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    await upsertUserTotp(db, {
      userId,
      secretCiphertext: ciphertext,
      secretIv: iv,
    });

    const after = await getUserTotpRow(db, userId);
    expect(after).not.toBeNull();
    expect(after!.totpEnabled).toBe(true);
    expect(Array.from(after!.secretCiphertext!)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(Array.from(after!.secretIv!)).toEqual([0x11, 0x22, 0x33, 0x44]);

    const confirmedAt = sqlite
      .prepare(`SELECT totp_confirmed_at AS t FROM users WHERE id = ?`)
      .get(userId) as { t: number | null };
    expect(confirmedAt.t).not.toBeNull();
    // confirmed within the last minute
    const nowSec = Math.floor(Date.now() / 1000);
    expect(confirmedAt.t!).toBeGreaterThan(nowSec - 60);
    expect(confirmedAt.t!).toBeLessThanOrEqual(nowSec + 1);
  });

  it("returns null for an unknown userId", async () => {
    expect(await getUserTotpRow(db, "no-such-user")).toBeNull();
  });
});
