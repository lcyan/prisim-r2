// tests/unit/api/r2-list-route.test.ts
//
// Integration spec for GET /api/r2/list. Same fat-test pattern as the
// buckets and presign route suites: real D1-shaped SQLite + real drizzle
// schema + real AES-GCM crypto. The two outer boundaries are stubbed:
//
//   - @/lib/r2/control.listObjects — so we don't make a real R2 round-
//     trip and can drive success / R2CredentialError / generic-upstream
//     branches and assert on the exact SDK call shape (Delimiter,
//     MaxKeys, ContinuationToken, Prefix).
//   - JWT + @opennextjs/cloudflare + auth adapter — standard middleware fixtures.
//
// What this suite proves end-to-end:
//   - happy path: returns R2ListResponse with the wire-shape `objects`,
//     `prefixes`, `nextCursor` and the correct SDK call (Delimiter='/'
//     and the configured MaxKeys).
//   - pagination: a follow-up request forwards `cursor` as
//     ContinuationToken to the SDK.
//   - empty page: returns stable `{ objects: [], prefixes: [],
//     nextCursor: null }` even when R2 omits the optional fields.
//   - last_used_at touched on success.
//   - user scope: another user's cid → 404 with no enumeration leak.
//   - decrypt failure → 500 + security.decrypt_failed audit row.
//   - R2 credential failure → 401 (our session is fine, R2 keys aren't).
//   - validation: missing/garbled cid / bucket rejected before any
//     decrypt happens.
//   - GET is exempt from CSRF.
//   - no credential material is ever included in any response body.

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
import { R2_LIST_DEFAULT_MAX_KEYS } from "@/lib/api/schemas";

// Deterministic 32-byte master key. 0x05 keeps these tests visually
// distinct from the other route suites (0x01 presign, 0x02 connections,
// 0x03 buckets) if a grep across the corpus is ever helpful.
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(5)).toString(
  "base64",
);

const FAKE_ACCESS_KEY = "AKIA-LIST-TEST-KEY-XYZ";
const FAKE_SECRET_KEY = "LIST-FAKE-SECRET-KEY-FOR-TESTS";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

// Mock the R2 control plane. Tests toggle listObjectsImpl per case to
// drive success / R2CredentialError / generic-upstream branches and to
// assert on the exact SDK params (Delimiter, MaxKeys, cursor passthrough).
// Importing the real R2CredentialError class keeps the `instanceof` route
// check honest.
import { R2CredentialError } from "@/lib/r2/errors";
const listObjectsImpl = vi.fn();
vi.mock("@/lib/r2/control", () => ({
  listObjects: (...args: unknown[]) => listObjectsImpl(...args),
}));

// makeS3Client validates non-empty strings — every call from the route
// has them, so a no-op stub is enough.
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
  const actual = await vi.importActual<typeof import("@/lib/db/client")>(
    "@/lib/db/client",
  );
  return {
    ...actual,
    // Both the route and audit log go through getDb(); returning a
    // single drizzle instance keeps every read/write on the same SQLite
    // handle.
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

// vi.mock is hoisted; route + listObjects imports MUST come after.
import { GET as listGET } from "@/app/api/r2/list/route";

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
       VALUES (?, ?, 'list-test', 'acct-fake',
               'https://acct-fake.r2.cloudflarestorage.com',
               'AKIA****-XYZ', ?, ?, ?, ?, ?)`,
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

interface ReqOpts {
  cid?: string | null;
  bucket?: string | null;
  prefix?: string | null;
  cursor?: string | null;
}

function listReq(opts: ReqOpts): Request {
  const url = new URL("https://x/api/r2/list");
  if (opts.cid != null) url.searchParams.set("cid", opts.cid);
  if (opts.bucket != null) url.searchParams.set("bucket", opts.bucket);
  if (opts.prefix != null) url.searchParams.set("prefix", opts.prefix);
  if (opts.cursor != null) url.searchParams.set("cursor", opts.cursor);
  return new Request(url.toString(), { method: "GET" });
}

async function readJson(res: Response): Promise<{
  objects?: Array<{
    key: string;
    size: number | null;
    etag: string | null;
    lastModified: number | null;
  }>;
  prefixes?: string[];
  nextCursor?: string | null;
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
  listObjectsImpl.mockReset();
});

describe("GET /api/r2/list — happy path", () => {
  it("returns R2ListResponse mapped from listObjects + uses Delimiter='/' and MaxKeys=200", async () => {
    const lastMod = new Date("2026-04-01T12:00:00Z");
    listObjectsImpl.mockResolvedValueOnce({
      items: [
        { key: "a/file.txt", size: 42, etag: '"etag-a"', lastModified: lastMod },
        { key: "a/other.bin", size: 7 },
      ],
      prefixes: ["a/sub1/", "a/sub2/"],
      continuationToken: "next-tok",
      isTruncated: true,
    });
    const { cid } = await seedUserAndConnection();
    const res = await listGET(listReq({ cid, bucket: "my-bucket", prefix: "a/" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      objects: Array<{
        key: string;
        size: number | null;
        etag: string | null;
        lastModified: number | null;
      }>;
      prefixes: string[];
      nextCursor: string | null;
    };
    expect(body).toEqual({
      objects: [
        {
          key: "a/file.txt",
          size: 42,
          etag: '"etag-a"',
          lastModified: lastMod.getTime(),
        },
        { key: "a/other.bin", size: 7, etag: null, lastModified: null },
      ],
      prefixes: ["a/sub1/", "a/sub2/"],
      nextCursor: "next-tok",
    });

    // Verify the route passed the right params into the SDK wrapper.
    expect(listObjectsImpl).toHaveBeenCalledOnce();
    const call = listObjectsImpl.mock.calls[0]![0] as {
      bucket: string;
      prefix: string;
      delimiter: string;
      maxKeys: number;
      continuationToken?: string;
    };
    expect(call.bucket).toBe("my-bucket");
    expect(call.prefix).toBe("a/");
    expect(call.delimiter).toBe("/");
    expect(call.maxKeys).toBe(R2_LIST_DEFAULT_MAX_KEYS);
    expect(call.continuationToken).toBeUndefined();
  });

  it("defaults prefix to '' when the query param is omitted", async () => {
    listObjectsImpl.mockResolvedValueOnce({
      items: [],
      prefixes: [],
      continuationToken: undefined,
      isTruncated: false,
    });
    const { cid } = await seedUserAndConnection();
    await listGET(listReq({ cid, bucket: "test-bucket" }));
    const call = listObjectsImpl.mock.calls[0]![0] as { prefix: string };
    expect(call.prefix).toBe("");
  });

  it("returns the stable empty-page shape when the bucket is empty", async () => {
    listObjectsImpl.mockResolvedValueOnce({
      items: [],
      prefixes: [],
      continuationToken: undefined,
      isTruncated: false,
    });
    const { cid } = await seedUserAndConnection();
    const res = await listGET(listReq({ cid, bucket: "empty-bucket" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      objects: [],
      prefixes: [],
      nextCursor: null,
    });
  });

  it("forwards `cursor` to ContinuationToken on follow-up pages", async () => {
    listObjectsImpl.mockResolvedValueOnce({
      items: [{ key: "b.txt", size: 1 }],
      prefixes: [],
      continuationToken: undefined,
      isTruncated: false,
    });
    const { cid } = await seedUserAndConnection();
    const res = await listGET(
      listReq({ cid, bucket: "test-bucket", cursor: "cursor-from-page-1" }),
    );
    expect(res.status).toBe(200);

    const call = listObjectsImpl.mock.calls[0]![0] as {
      continuationToken?: string;
    };
    expect(call.continuationToken).toBe("cursor-from-page-1");

    // The follow-up page exhausts the listing, so nextCursor is null.
    const body = await readJson(res);
    expect(body.nextCursor).toBeNull();
  });

  it("touches connection.last_used_at on success", async () => {
    listObjectsImpl.mockResolvedValueOnce({
      items: [],
      prefixes: [],
      continuationToken: undefined,
      isTruncated: false,
    });
    const { userId, cid } = await seedUserAndConnection();

    const before = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(cid) as { last_used_at: number | null };
    expect(before.last_used_at).toBeNull();

    const startSec = Math.floor(Date.now() / 1000) - 1;
    const res = await listGET(listReq({ cid, bucket: "test-bucket" }));
    expect(res.status).toBe(200);

    const after = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(cid) as { last_used_at: number | null };
    expect(after.last_used_at).not.toBeNull();
    expect(after.last_used_at!).toBeGreaterThanOrEqual(startSec);

    // Reads do not emit audit rows on success — matches the buckets +
    // connections-list policy.
    expect(auditRowsForUser(userId)).toHaveLength(0);
  });
});

describe("GET /api/r2/list — validation", () => {
  it("rejects missing cid with 400 (no probe)", async () => {
    await seedUserAndConnection();
    const res = await listGET(listReq({ bucket: "test-bucket" }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
    expect(listObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects missing bucket with 400", async () => {
    const { cid } = await seedUserAndConnection();
    const res = await listGET(listReq({ cid }));
    expect(res.status).toBe(400);
    expect(listObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-ULID cid with 400", async () => {
    await seedUserAndConnection();
    const res = await listGET(listReq({ cid: "not-a-ulid", bucket: "test-bucket" }));
    expect(res.status).toBe(400);
    expect(listObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects bucket names that violate S3 naming rules", async () => {
    const { cid } = await seedUserAndConnection();
    // Uppercase isn't allowed by the BucketNameSchema regex.
    const res = await listGET(listReq({ cid, bucket: "INVALID-Bucket" }));
    expect(res.status).toBe(400);
    expect(listObjectsImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/r2/list — authorization & scoping", () => {
  it("returns 404 when the connection does not exist for this user", async () => {
    await seedUserAndConnection();
    const nonExistent = ulid();
    const res = await listGET(listReq({ cid: nonExistent, bucket: "test-bucket" }));
    expect(res.status).toBe(404);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.NotFound);
    expect(listObjectsImpl).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when cid belongs to another user — no enumeration", async () => {
    const userA = await seedUserAndConnection({ loginAs: false });
    await seedUserAndConnection({ loginAs: true });

    const res = await listGET(listReq({ cid: userA.cid, bucket: "test-bucket" }));
    expect(res.status).toBe(404);

    // The victim's connection was never touched.
    const row = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(userA.cid) as { last_used_at: number | null };
    expect(row.last_used_at).toBeNull();
    expect(auditRowsForUser(userA.userId)).toHaveLength(0);
  });

  it("rejects unauthenticated requests with 401 auth.unauthorized", async () => {
    const res = await listGET(listReq({ cid: ulid(), bucket: "test-bucket" }));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );
  });

  it("serves GET without an X-CSRF-Token header (GET is exempt)", async () => {
    listObjectsImpl.mockResolvedValueOnce({
      items: [],
      prefixes: [],
      continuationToken: undefined,
      isTruncated: false,
    });
    const { cid } = await seedUserAndConnection();
    const res = await listGET(listReq({ cid, bucket: "test-bucket" }));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/r2/list — error paths", () => {
  it("decrypt failure → 500 + security.decrypt_failed audit row", async () => {
    const { userId, cid } = await seedUserAndConnection();
    // Corrupt the access-key ciphertext so AES-GCM tag verification fails.
    sqlite
      .prepare(`UPDATE connections SET access_key_ciphertext = ? WHERE id = ?`)
      .run(Buffer.from(new Uint8Array(48).fill(0xff)), cid);

    const res = await listGET(listReq({ cid, bucket: "test-bucket" }));
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
    // listObjects must not have been attempted with a half-decrypted key.
    expect(listObjectsImpl).not.toHaveBeenCalled();
  });

  it("R2CredentialError → 401 auth.unauthorized (user's R2 keys, not OUR session)", async () => {
    listObjectsImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid } = await seedUserAndConnection();

    const res = await listGET(listReq({ cid, bucket: "test-bucket" }));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );

    // No last_used_at update for a failed call.
    const row = sqlite
      .prepare(`SELECT last_used_at FROM connections WHERE id = ?`)
      .get(cid) as { last_used_at: number | null };
    expect(row.last_used_at).toBeNull();
    // No audit row either (failure of an unaudited read).
    expect(auditRowsForUser(userId)).toHaveLength(0);
  });
});

describe("GET /api/r2/list — no credential leakage in any response", () => {
  it("response body does not contain raw access/secret material, even on error", async () => {
    listObjectsImpl.mockRejectedValueOnce(new R2CredentialError());
    const { cid } = await seedUserAndConnection();
    const res = await listGET(listReq({ cid, bucket: "test-bucket" }));
    const body = await res.text();
    expect(body).not.toContain(FAKE_ACCESS_KEY);
    expect(body).not.toContain(FAKE_SECRET_KEY);
    expect(body).not.toContain(FAKE_ACCESS_KEY.slice(0, 4));
  });
});
