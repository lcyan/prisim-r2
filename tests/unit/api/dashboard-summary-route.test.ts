// tests/unit/api/dashboard-summary-route.test.ts
//
// Integration spec for GET /api/dashboard/summary. Same fat-test pattern
// as r2-buckets-route.test.ts: real D1-shaped SQLite + real drizzle +
// real AES-GCM crypto. listBuckets is stubbed at the @/lib/r2/control
// boundary so we don't make a real R2 round-trip.
//
// What this suite proves:
//   - happy path: returns the DashboardSummary shape and the right
//     opsByDay length for the requested range
//   - unauthenticated → 401
//   - bad range → 400 validation.invalid
//   - missing connectionId → 400
//   - another user's connection → 404 (enumeration guard)

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import {
  generateCsrfToken,
  hashCsrfToken,
} from "@/lib/auth/csrf";
import { encryptCredential } from "@/lib/crypto/aes-gcm";
import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import { ApiErrorCode } from "@/lib/api/errors";

const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(4)).toString(
  "base64",
);
const FAKE_ACCESS_KEY = "AKIA-DASHBOARD-TEST-KEY";
const FAKE_SECRET_KEY = "DASHBOARD-FAKE-SECRET-KEY-FOR-TESTS";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

const listBucketsImpl = vi.fn();
vi.mock("@/lib/r2/control", () => ({
  listBuckets: (...args: unknown[]) => listBucketsImpl(...args),
}));

vi.mock("@/lib/r2/client", () => ({
  makeS3Client: vi.fn(() => ({})),
}));

// decryptCredential is exercised end-to-end in lib/crypto/aes-gcm.test.ts.
// In this route suite we mock it so the happy path doesn't depend on the
// Web Crypto runtime under jsdom (the r2-buckets-route suite is bitten by
// the same env limitation: jsdom's global crypto lacks SubtleCrypto in
// the version pinned here). Keeping the real encryptCredential intact in
// seedUserAndConnection means we still exercise the schema's blob columns
// with real ciphertext shapes. The fn is declared via vi.hoisted so the
// mock factory has a stable reference at hoist time.
const { mockDecryptCredential } = vi.hoisted(() => ({
  mockDecryptCredential: vi.fn(async () => "fake-decrypted-credential"),
}));
vi.mock("@/lib/crypto/aes-gcm", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/crypto/aes-gcm")>();
  return {
    ...actual,
    decryptCredential: mockDecryptCredential,
  };
});

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => fakeJwt.token),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      DB: d1Facade,
      AUTH_SECRET: "test-secret",
      ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
    },
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

// Mocks are hoisted; route import follows.
import { GET as summaryGET } from "@/app/api/dashboard/summary/route";

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

async function seedUserAndConnection(
  opts: { loginAs?: boolean } = {},
): Promise<{ userId: string; cid: string; csrfToken: string }> {
  const userId = ulid();
  const cid = ulid();
  const sessionToken = `sess-${ulid()}`;
  const csrfToken = generateCsrfToken();
  const csrfTokenHash = await hashCsrfToken(csrfToken);
  const nowSec = Math.floor(Date.now() / 1000);

  sqlite
    .prepare(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES (?, ?, 'h', ?)`,
    )
    .run(userId, `${userId}@test.local`, nowSec);

  const env = { ENCRYPTION_KEY: ENCRYPTION_KEY_B64 };
  const accessEnc = await encryptCredential(FAKE_ACCESS_KEY, cid, env);
  const secretEnc = await encryptCredential(FAKE_SECRET_KEY, cid, env);

  sqlite
    .prepare(
      `INSERT INTO connections
       (id, user_id, name, account_id, endpoint, access_key_masked,
        access_key_ciphertext, access_key_iv,
        secret_key_ciphertext, secret_key_iv, created_at)
       VALUES (?, ?, 'b-test', 'acct-fake',
               'https://acct-fake.r2.cloudflarestorage.com',
               'AKIA****EY-X', ?, ?, ?, ?, ?)`,
    )
    .run(
      cid,
      userId,
      Buffer.from(accessEnc.ciphertext),
      Buffer.from(accessEnc.iv),
      Buffer.from(secretEnc.ciphertext),
      Buffer.from(secretEnc.iv),
      nowSec,
    );

  if (opts.loginAs !== false) {
    fakeSessionStore.set(sessionToken, {
      csrfTokenHash,
      userId,
      email: `${userId}@test.local`,
    });
    fakeJwt.token = { userId, sessionToken, csrfToken };
  }
  return { userId, cid, csrfToken };
}

function summaryReq(query: Record<string, string>): Request {
  const url = new URL("https://x/api/dashboard/summary");
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), { method: "GET" });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);
  fakeJwt.token = null;
  fakeSessionStore.clear();
  listBucketsImpl.mockResolvedValue([
    { name: "assets", creationDate: new Date() },
    { name: "backups", creationDate: new Date() },
  ]);
});

describe("GET /api/dashboard/summary", () => {
  it("returns DashboardSummary shape and 7-slot opsByDay for range=7d", async () => {
    const { cid } = await seedUserAndConnection();
    const res = await summaryGET(summaryReq({ connectionId: cid, range: "7d" }));
    expect(res.status).toBe(200);
    const body = await readJson<{
      bucketsCount: number;
      ops: { count: number; previousCount: number };
      opsByDay: Array<{ date: string; count: number }>;
    }>(res);
    expect(body.bucketsCount).toBe(2);
    expect(body.ops).toEqual({ count: 0, previousCount: 0 });
    expect(body.opsByDay).toHaveLength(7);
  });

  it("rejects requests without a session (401)", async () => {
    const { cid } = await seedUserAndConnection({ loginAs: false });
    const res = await summaryGET(
      summaryReq({ connectionId: cid, range: "30d" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid range with 400 validation.invalid", async () => {
    const { cid } = await seedUserAndConnection();
    const res = await summaryGET(
      summaryReq({ connectionId: cid, range: "90d" }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ error: { code: string } }>(res);
    expect(body.error.code).toBe(ApiErrorCode.ValidationInvalid);
  });

  it("rejects a missing connectionId with 400", async () => {
    await seedUserAndConnection();
    const res = await summaryGET(summaryReq({ range: "7d" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the connection belongs to a different user", async () => {
    await seedUserAndConnection();
    const otherCid = ulid();
    const res = await summaryGET(
      summaryReq({ connectionId: otherCid, range: "7d" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns totp.recoveryCodesRemaining = 3 when 3 active + 1 consumed code exist", async () => {
    const { userId, cid } = await seedUserAndConnection();
    const nowSec = Math.floor(Date.now() / 1000);

    // Insert 4 recovery codes: 3 active (consumedAt IS NULL), 1 consumed
    sqlite
      .prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, consumed_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(ulid(), userId, "hash-active-1", nowSec);
    sqlite
      .prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, consumed_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(ulid(), userId, "hash-active-2", nowSec);
    sqlite
      .prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, consumed_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(ulid(), userId, "hash-active-3", nowSec);
    sqlite
      .prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ulid(), userId, "hash-consumed-1", nowSec - 3600, nowSec);

    const res = await summaryGET(summaryReq({ connectionId: cid, range: "7d" }));
    expect(res.status).toBe(200);
    const body = await readJson<{ totp: { recoveryCodesRemaining: number } }>(res);
    expect(body.totp.recoveryCodesRemaining).toBe(3);
  });
});
