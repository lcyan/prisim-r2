// tests/unit/api/r2-buckets-route.test.ts
//
// Integration spec for GET /api/r2/buckets. Same fat-test pattern as
// r2-presign-route.test.ts: real D1-shaped SQLite + real drizzle schema +
// real AES-GCM crypto. The two outer boundaries are stubbed:
//
//   - @/lib/r2/control.listBuckets — so we don't make a real R2 round-trip
//     and can drive success / R2CredentialError / generic-upstream branches.
//   - JWT + @opennextjs/cloudflare + auth adapter — standard middleware fixtures.
//
// What this suite proves end-to-end:
//   - happy path: returns BucketSummary[] mapped from the SDK shape
//   - last_used_at is updated on success (the dashboard's "used X ago"
//     indicator relies on this)
//   - user scope: another user's cid returns 404 with no enumeration leak
//   - decrypt failure → 500 + security.decrypt_failed audit row
//   - R2 credential failure → 401 (OUR session is fine, R2 keys aren't)
//   - validation: missing/garbled cid is rejected before any decrypt
//   - GET is exempt from CSRF (no header → still served)

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { generateCsrfToken, hashCsrfToken } from "@/lib/auth/csrf";
import { encryptCredential } from "@/lib/crypto/aes-gcm";
import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import { ApiErrorCode } from "@/lib/api/errors";

// Deterministic 32-byte master key — same convention as the presign suite.
// Reusing 0x03 (not 0x01 or 0x02) keeps these tests visually distinct from
// the existing route suites in case grep over the test corpus is helpful.
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(3)).toString(
  "base64",
);

const FAKE_ACCESS_KEY = "AKIA-BUCKETS-TEST-KEY-X";
const FAKE_SECRET_KEY = "BUCKETS-FAKE-SECRET-KEY-FOR-TESTS";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

// Mock the R2 control plane. Tests toggle listBucketsImpl per case to drive
// success / R2CredentialError / generic-upstream branches. Importing the
// real R2CredentialError class keeps the `instanceof` route check honest.
import { R2CredentialError } from "@/lib/r2/errors";
const listBucketsImpl = vi.fn();
vi.mock("@/lib/r2/control", () => ({
  listBuckets: (...args: unknown[]) => listBucketsImpl(...args),
}));

// makeS3Client validates non-empty strings — every call from the route has
// them, so a no-op stub is enough. We keep it explicit so a future change
// (e.g. DNS-style validation) doesn't silently break unit tests.
vi.mock("@/lib/r2/client", () => ({
  makeS3Client: vi.fn(() => ({})),
}));

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
  const actual =
    await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
  return {
    ...actual,
    // Both the route and audit log go through getDb(); returning a single
    // drizzle instance keeps every read/write on the same SQLite handle.
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

// vi.mock is hoisted; route + listBuckets imports MUST come after.
import { GET as bucketsGET } from "@/app/api/r2/buckets/route";

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

/** Seed a user + a connection with REAL encrypted credentials. Returns
 *  everything the test needs to call GET as that user. */
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

function bucketsReq(cid: string | null): Request {
  const url = cid
    ? `https://x/api/r2/buckets?cid=${cid}`
    : `https://x/api/r2/buckets`;
  return new Request(url, { method: "GET" });
}

async function readJson(res: Response): Promise<{
  buckets?: Array<{ name: string; createdAt: number | null }>;
  error?: { code: string; message: string; requestId: string };
}> {
  return (await res.json()) as Awaited<ReturnType<typeof readJson>>;
}

function auditRowsForUser(userId: string): Array<{
  op: string;
  status: string;
  connection_id: string | null;
  error_msg: string | null;
}> {
  return sqlite
    .prepare(
      `SELECT op, status, connection_id, error_msg
       FROM audit_log WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as Array<{
    op: string;
    status: string;
    connection_id: string | null;
    error_msg: string | null;
  }>;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);
  fakeJwt.token = null;
  fakeSessionStore.clear();
  listBucketsImpl.mockReset();
});

describe("GET /api/r2/buckets — happy path", () => {
  it("returns a BucketSummary[] mapped from the SDK shape", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    listBucketsImpl.mockResolvedValueOnce([
      { name: "primary", creationDate: created },
      { name: "secondary", creationDate: undefined },
    ]);
    const { cid } = await seedUserAndConnection();
    const res = await bucketsGET(bucketsReq(cid));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      createdAt: number | null;
    }>;
    expect(body).toEqual([
      { name: "primary", createdAt: created.getTime() },
      { name: "secondary", createdAt: null },
    ]);
  });

  it("filters out SDK entries with no name (defensive — R2 doesn't do this in practice)", async () => {
    listBucketsImpl.mockResolvedValueOnce([
      { name: "kept", creationDate: undefined },
      // SDK type allows Name?: undefined; we must not emit `name: ""`.
      { name: undefined, creationDate: undefined },
      { name: "", creationDate: undefined },
    ]);
    const { cid } = await seedUserAndConnection();
    const res = await bucketsGET(bucketsReq(cid));
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.map((b) => b.name)).toEqual(["kept"]);
  });

  it("touches connection.last_used_at on success", async () => {
    listBucketsImpl.mockResolvedValueOnce([]);
    const { userId, cid } = await seedUserAndConnection();

    // Sanity: the seed inserted last_used_at as NULL.
    const before = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(cid) as { last_used_at: number | null };
    expect(before.last_used_at).toBeNull();

    const startSec = Math.floor(Date.now() / 1000) - 1;
    const res = await bucketsGET(bucketsReq(cid));
    expect(res.status).toBe(200);

    const after = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(cid) as { last_used_at: number | null };
    expect(after.last_used_at).not.toBeNull();
    // Drizzle stores `mode: "timestamp"` as unix seconds.
    expect(after.last_used_at!).toBeGreaterThanOrEqual(startSec);

    // Read does not write any audit row on success — matches the
    // GET /api/connections policy.
    expect(auditRowsForUser(userId)).toHaveLength(0);
  });
});

describe("GET /api/r2/buckets — validation", () => {
  it("rejects missing cid with 400 validation.invalid (no probe)", async () => {
    await seedUserAndConnection();
    const res = await bucketsGET(bucketsReq(null));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-ULID cid with 400", async () => {
    await seedUserAndConnection();
    const res = await bucketsGET(bucketsReq("not-a-ulid"));
    expect(res.status).toBe(400);
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/r2/buckets — authorization & scoping", () => {
  it("returns 404 when the connection does not exist for this user", async () => {
    await seedUserAndConnection();
    const nonExistent = ulid();
    const res = await bucketsGET(bucketsReq(nonExistent));
    expect(res.status).toBe(404);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.NotFound);
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when cid belongs to another user — no enumeration", async () => {
    // User A's connection.
    const userA = await seedUserAndConnection({ loginAs: false });
    // User B is logged in.
    await seedUserAndConnection({ loginAs: true });

    const res = await bucketsGET(bucketsReq(userA.cid));
    expect(res.status).toBe(404);

    // User A's connection was never touched — last_used_at remains NULL
    // and no audit row was attributed to them.
    const userARow = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(userA.cid) as { last_used_at: number | null };
    expect(userARow.last_used_at).toBeNull();
    expect(auditRowsForUser(userA.userId)).toHaveLength(0);
  });

  it("rejects unauthenticated requests with 401 auth.unauthorized", async () => {
    // fakeJwt.token stays null from beforeEach.
    const res = await bucketsGET(bucketsReq(ulid()));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );
  });

  it("serves GET without an X-CSRF-Token header (GET is exempt)", async () => {
    // The bucketsReq helper omits the CSRF header by construction. The test
    // is a regression guard: a future change that wrongly enforces CSRF on
    // GETs would flip this to a 401 csrf.invalid.
    listBucketsImpl.mockResolvedValueOnce([]);
    const { cid } = await seedUserAndConnection();
    const res = await bucketsGET(bucketsReq(cid));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/r2/buckets — error paths", () => {
  it("decrypt failure → 500 + security.decrypt_failed audit row", async () => {
    const { userId, cid } = await seedUserAndConnection();
    // Corrupt the access-key ciphertext so AES-GCM tag verification fails.
    sqlite
      .prepare(`UPDATE connections SET access_key_ciphertext = ? WHERE id = ?`)
      .run(Buffer.from(new Uint8Array(48).fill(0xff)), cid);

    const res = await bucketsGET(bucketsReq(cid));
    expect(res.status).toBe(500);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.InternalUnexpected,
    );

    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "security.decrypt_failed",
      status: "failure",
    });
    // listBuckets must not have been attempted with a half-decrypted key.
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });

  it("R2CredentialError → 401 auth.unauthorized (user's R2 keys, not OUR session)", async () => {
    listBucketsImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid } = await seedUserAndConnection();

    const res = await bucketsGET(bucketsReq(cid));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );

    // No `last_used_at` update for a failed call — the timestamp is "last
    // successful use", which a credential rejection isn't.
    const row = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(cid) as { last_used_at: number | null };
    expect(row.last_used_at).toBeNull();
    // No audit row either (failure of an unaudited read).
    expect(auditRowsForUser(userId)).toHaveLength(0);
  });
});

describe("GET /api/r2/buckets — no credential leakage in any response", () => {
  it("response body does not contain raw access/secret material, even on error", async () => {
    listBucketsImpl.mockRejectedValueOnce(new R2CredentialError());
    const { cid } = await seedUserAndConnection();
    const res = await bucketsGET(bucketsReq(cid));
    const body = await res.text();
    expect(body).not.toContain(FAKE_ACCESS_KEY);
    expect(body).not.toContain(FAKE_SECRET_KEY);
    expect(body).not.toContain(FAKE_ACCESS_KEY.slice(0, 4));
  });
});
