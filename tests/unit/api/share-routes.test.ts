// tests/unit/api/share-routes.test.ts
//
// Integration spec for the share routes:
//   POST   /api/share/create
//   GET    /api/share
//   DELETE /api/share/:id
//
// Same fat-test pattern as r2-delete-routes / r2-list-route: real
// D1-shaped SQLite + real drizzle + real AES-GCM. Only the R2 SDK
// surface (presignGet) and makeS3Client are stubbed so we can drive
// success / R2CredentialError without a real network round-trip.
//
// What this suite proves:
//   - create: rejects out-of-range ttlSeconds (400), enforces ULID cid +
//     ObjectKey rules, mints a URL + persists exactly one row + writes
//     ONE share.create success audit row containing a non-empty url_hash
//     that is NOT the URL itself.
//   - create: another user's cid → 404 (no enumeration disclosure).
//   - create: presign failure (R2CredentialError) → 401 + failure audit
//     and no shares row written.
//   - list: returns only the current user's unexpired rows ordered DESC,
//     never includes a URL field, paginates via opaque cursor, and emits
//     a `nextCursor` only when more rows exist.
//   - delete: removes the row, returns { ok: true, id }, 404 (not 403) on
//     another user's row, writes a share.delete audit row on both success
//     and failure.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import {
  CSRF_HEADER_NAME,
  generateCsrfToken,
  hashCsrfToken,
} from "@/lib/auth/csrf";
import { encryptCredential } from "@/lib/crypto/aes-gcm";
import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import { ApiErrorCode } from "@/lib/api/errors";

// Deterministic 32-byte master key. 0x0a distinguishes from the other
// route suites for greppability.
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(0x0a)).toString(
  "base64",
);
const AUTH_SECRET = "share-route-test-auth-secret";

const FAKE_ACCESS_KEY = "AKIA-SHARE-TEST-KEY-PQRS";
const FAKE_SECRET_KEY = "SHARE-FAKE-SECRET-KEY-FOR-TESTS";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

const presignGetImpl = vi.fn();
vi.mock("@/lib/r2/presign", () => ({
  presignGet: (...args: unknown[]) => presignGetImpl(...args),
}));

vi.mock("@/lib/r2/client", () => ({
  makeS3Client: vi.fn(() => ({})),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => fakeJwt.token),
}));

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: () => ({
    env: {
      DB: d1Facade,
      AUTH_SECRET,
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

// Mocks are hoisted; route imports must follow.
import { R2CredentialError } from "@/lib/r2/errors";
import { POST as createPOST } from "@/app/api/share/create/route";
import { GET as listGET } from "@/app/api/share/route";
import { DELETE as deleteDELETE } from "@/app/api/share/[id]/route";

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
       VALUES (?, ?, 'share-test', 'acct-fake',
               'https://acct-fake.r2.cloudflarestorage.com',
               'AKIA****PQRS', ?, ?, ?, ?, ?)`,
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

function postReq(pathSuffix: string, body: unknown, csrfToken: string): Request {
  return new Request(`https://x/api/share/${pathSuffix}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function listReq(cursor?: string): Request {
  const url = new URL("https://x/api/share");
  if (cursor) url.searchParams.set("cursor", cursor);
  return new Request(url.toString(), { method: "GET" });
}

function deleteReq(id: string, csrfToken: string): Request {
  return new Request(`https://x/api/share/${id}`, {
    method: "DELETE",
    headers: { [CSRF_HEADER_NAME]: csrfToken },
  });
}

async function readJson(res: Response): Promise<{
  id?: string;
  url?: string;
  expiresAt?: number;
  items?: Array<{
    id: string;
    bucket: string;
    key: string;
    ttlSeconds: number;
    createdAt: number;
    expiresAt: number;
  }>;
  nextCursor?: string | null;
  ok?: true;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}> {
  return (await res.json()) as Awaited<ReturnType<typeof readJson>>;
}

function auditRowsForUser(userId: string): Array<{
  op: string;
  status: string;
  connection_id: string | null;
  bucket: string | null;
  object_key: string | null;
  error_msg: string | null;
}> {
  return sqlite
    .prepare(
      `SELECT op, status, connection_id, bucket, object_key, error_msg
       FROM audit_log WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as Array<{
    op: string;
    status: string;
    connection_id: string | null;
    bucket: string | null;
    object_key: string | null;
    error_msg: string | null;
  }>;
}

function sharesForUser(userId: string): Array<{
  id: string;
  bucket: string;
  object_key: string;
  url_hash: string;
  ttl_seconds: number;
  connection_id: string;
}> {
  return sqlite
    .prepare(
      `SELECT id, bucket, object_key, url_hash, ttl_seconds, connection_id
       FROM shares WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as Array<{
    id: string;
    bucket: string;
    object_key: string;
    url_hash: string;
    ttl_seconds: number;
    connection_id: string;
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
  presignGetImpl.mockReset();
});

/* ───────── POST /api/share/create ───────── */

describe("POST /api/share/create — happy path", () => {
  it("mints a URL, inserts ONE shares row, and returns { id, url, expiresAt }", async () => {
    presignGetImpl.mockResolvedValueOnce(
      "https://acct-fake.r2.cloudflarestorage.com/my-bucket/a.txt?X-Amz-Signature=deadbeef",
    );
    const { userId, cid, csrfToken } = await seedUserAndConnection();

    const before = Date.now();
    const res = await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 3600 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(body.url).toMatch(/X-Amz-Signature=/u);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);

    const rows = sharesForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucket).toBe("my-bucket");
    expect(rows[0]!.object_key).toBe("a.txt");
    expect(rows[0]!.ttl_seconds).toBe(3600);
    expect(rows[0]!.connection_id).toBe(cid);
    // url_hash is sha256 hex (64 chars), NOT the URL itself.
    expect(rows[0]!.url_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0]!.url_hash).not.toBe(body.url);
  });

  it("forwards ttlSeconds to presignGet so the signature window matches", async () => {
    presignGetImpl.mockResolvedValueOnce("https://r2/?sig=1");
    const { cid, csrfToken } = await seedUserAndConnection();
    await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 604800 },
        csrfToken,
      ),
    );
    expect(presignGetImpl).toHaveBeenCalledOnce();
    const call = presignGetImpl.mock.calls[0]![0] as { ttl: number };
    expect(call.ttl).toBe(604800);
  });

  it("writes ONE share.create success audit row", async () => {
    presignGetImpl.mockResolvedValueOnce("https://r2/?sig=ok");
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 3600 },
        csrfToken,
      ),
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "share.create",
      status: "success",
      connection_id: cid,
      bucket: "my-bucket",
      object_key: "a.txt",
    });
  });
});

describe("POST /api/share/create — validation", () => {
  it("rejects ttlSeconds outside the 3 allowed literals (400)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 1800 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
    expect(presignGetImpl).not.toHaveBeenCalled();
  });

  it("rejects an unknown extra field (strict schema)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      postReq(
        "create",
        {
          cid,
          bucket: "my-bucket",
          key: "a.txt",
          ttlSeconds: 3600,
          rogue: true,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a leading-slash key (ObjectKeySchema)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "/a.txt", ttlSeconds: 3600 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects requests without a session (401)", async () => {
    const res = await createPOST(
      postReq(
        "create",
        { cid: ulid(), bucket: "my-bucket", key: "a.txt", ttlSeconds: 3600 },
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
  });

  it("rejects POST without a matching X-CSRF-Token (401)", async () => {
    const { cid } = await seedUserAndConnection();
    const res = await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 3600 },
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
  });
});

describe("POST /api/share/create — security / failure paths", () => {
  it("returns 404 (not 403) when cid belongs to another user", async () => {
    const userA = await seedUserAndConnection({ loginAs: false });
    const userB = await seedUserAndConnection({ loginAs: true });
    const res = await createPOST(
      postReq(
        "create",
        {
          cid: userA.cid,
          bucket: "my-bucket",
          key: "a.txt",
          ttlSeconds: 3600,
        },
        userB.csrfToken,
      ),
    );
    expect(res.status).toBe(404);
    expect(sharesForUser(userA.userId)).toHaveLength(0);
    expect(sharesForUser(userB.userId)).toHaveLength(0);
  });

  it("R2CredentialError → 401 and no shares row written", async () => {
    presignGetImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 3600 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(401);
    expect(sharesForUser(userId)).toHaveLength(0);
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "share.create", status: "failure" });
  });

  it("decrypt failure → 500 + security.decrypt_failed audit row", async () => {
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    sqlite
      .prepare(`UPDATE connections SET access_key_ciphertext = ? WHERE id = ?`)
      .run(Buffer.from(new Uint8Array(48).fill(0xff)), cid);

    const res = await createPOST(
      postReq(
        "create",
        { cid, bucket: "my-bucket", key: "a.txt", ttlSeconds: 3600 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(500);
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "security.decrypt_failed",
      status: "failure",
    });
    expect(presignGetImpl).not.toHaveBeenCalled();
    expect(sharesForUser(userId)).toHaveLength(0);
  });
});

/* ───────── GET /api/share ───────── */

/**
 * Insert a share row directly. Faster than going through the route and
 * lets us seed deterministic createdAt values for ordering / cursor tests.
 */
function insertShareRow(args: {
  userId: string;
  cid: string;
  bucket: string;
  key: string;
  ttlSeconds: number;
  /** Seconds since epoch — both createdAt and (createdAt + ttl) are derived. */
  createdAtSec: number;
  /** When set, overrides expires_at (used to seed an already-expired row). */
  expiresAtSec?: number;
}): string {
  const id = ulid();
  const expires = args.expiresAtSec ?? args.createdAtSec + args.ttlSeconds;
  sqlite
    .prepare(
      `INSERT INTO shares
       (id, user_id, connection_id, bucket, object_key, url_hash,
        ttl_seconds, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.userId,
      args.cid,
      args.bucket,
      args.key,
      // 64-char hex placeholder — the route never reads url_hash.
      "0".repeat(64),
      args.ttlSeconds,
      expires,
      args.createdAtSec,
    );
  return id;
}

describe("GET /api/share — listing", () => {
  it("returns the user's unexpired rows newest-first; never includes a URL", async () => {
    const { userId, cid } = await seedUserAndConnection();
    const now = Math.floor(Date.now() / 1000);
    insertShareRow({
      userId,
      cid,
      bucket: "b",
      key: "old.txt",
      ttlSeconds: 3600,
      createdAtSec: now - 100,
    });
    insertShareRow({
      userId,
      cid,
      bucket: "b",
      key: "new.txt",
      ttlSeconds: 3600,
      createdAtSec: now - 10,
    });
    const res = await listGET(listReq());
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["new.txt", "old.txt"]);
    // No url field exposed.
    for (const item of body.items ?? []) {
      expect((item as unknown as Record<string, unknown>).url).toBeUndefined();
    }
    expect(body.nextCursor).toBeNull();
  });

  it("excludes expired rows", async () => {
    const { userId, cid } = await seedUserAndConnection();
    const now = Math.floor(Date.now() / 1000);
    insertShareRow({
      userId,
      cid,
      bucket: "b",
      key: "expired.txt",
      ttlSeconds: 3600,
      createdAtSec: now - 7200,
      expiresAtSec: now - 1, // already expired
    });
    insertShareRow({
      userId,
      cid,
      bucket: "b",
      key: "alive.txt",
      ttlSeconds: 3600,
      createdAtSec: now - 10,
    });
    const res = await listGET(listReq());
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["alive.txt"]);
  });

  it("excludes other users' rows", async () => {
    const userA = await seedUserAndConnection({ loginAs: false });
    const userB = await seedUserAndConnection({ loginAs: true });
    const now = Math.floor(Date.now() / 1000);
    insertShareRow({
      userId: userA.userId,
      cid: userA.cid,
      bucket: "b",
      key: "userA.txt",
      ttlSeconds: 3600,
      createdAtSec: now - 10,
    });
    insertShareRow({
      userId: userB.userId,
      cid: userB.cid,
      bucket: "b",
      key: "userB.txt",
      ttlSeconds: 3600,
      createdAtSec: now - 5,
    });
    const res = await listGET(listReq());
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["userB.txt"]);
  });

  it("paginates via opaque cursor when more rows exist than the page size", async () => {
    const { userId, cid } = await seedUserAndConnection();
    const now = Math.floor(Date.now() / 1000);
    // Seed 52 rows: page size is 50, so page 1 returns 50 + nextCursor,
    // and page 2 returns the remaining 2 + nextCursor=null.
    for (let i = 0; i < 52; i++) {
      insertShareRow({
        userId,
        cid,
        bucket: "b",
        key: `k${i.toString().padStart(3, "0")}.txt`,
        ttlSeconds: 3600,
        createdAtSec: now - (60 - i), // ascending — newest is i=51
      });
    }
    const res1 = await listGET(listReq());
    const body1 = await readJson(res1);
    expect(body1.items).toHaveLength(50);
    expect(body1.nextCursor).toBeTypeOf("string");

    const res2 = await listGET(listReq(body1.nextCursor!));
    const body2 = await readJson(res2);
    expect(body2.items).toHaveLength(2);
    expect(body2.nextCursor).toBeNull();
    // Combined pages cover every key exactly once.
    const seen = new Set<string>();
    for (const it of [...(body1.items ?? []), ...(body2.items ?? [])]) {
      expect(seen.has(it.key)).toBe(false);
      seen.add(it.key);
    }
    expect(seen.size).toBe(52);
  });

  it("rejects a malformed cursor (400)", async () => {
    await seedUserAndConnection();
    const res = await listGET(listReq("not-a-cursor"));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
  });

  it("rejects requests without a session (401)", async () => {
    const res = await listGET(listReq());
    expect(res.status).toBe(401);
  });
});

/* ───────── DELETE /api/share/[id] ───────── */

describe("DELETE /api/share/[id]", () => {
  it("removes the row and returns { ok: true, id }", async () => {
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const id = insertShareRow({
      userId,
      cid,
      bucket: "b",
      key: "a.txt",
      ttlSeconds: 3600,
      createdAtSec: Math.floor(Date.now() / 1000),
    });
    const res = await deleteDELETE(deleteReq(id, csrfToken));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(id);
    expect(sharesForUser(userId)).toHaveLength(0);
  });

  it("writes a share.delete success audit row with bucket/key context", async () => {
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const id = insertShareRow({
      userId,
      cid,
      bucket: "b",
      key: "z.txt",
      ttlSeconds: 3600,
      createdAtSec: Math.floor(Date.now() / 1000),
    });
    await deleteDELETE(deleteReq(id, csrfToken));
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "share.delete",
      status: "success",
      connection_id: cid,
      bucket: "b",
      object_key: "z.txt",
    });
  });

  it("returns 404 (not 403) when id belongs to another user", async () => {
    const userA = await seedUserAndConnection({ loginAs: false });
    const userB = await seedUserAndConnection({ loginAs: true });
    const aId = insertShareRow({
      userId: userA.userId,
      cid: userA.cid,
      bucket: "b",
      key: "a.txt",
      ttlSeconds: 3600,
      createdAtSec: Math.floor(Date.now() / 1000),
    });
    const res = await deleteDELETE(deleteReq(aId, userB.csrfToken));
    expect(res.status).toBe(404);
    // userA's row is untouched.
    expect(sharesForUser(userA.userId)).toHaveLength(1);
    // userB gets a failure audit row scoped to themselves.
    const bRows = auditRowsForUser(userB.userId);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({
      op: "share.delete",
      status: "failure",
      error_msg: "not_found",
    });
  });

  it("rejects a non-ULID id with 400", async () => {
    const { csrfToken } = await seedUserAndConnection();
    const res = await deleteDELETE(deleteReq("not-a-ulid", csrfToken));
    expect(res.status).toBe(400);
  });

  it("rejects requests without a session (401)", async () => {
    const res = await deleteDELETE(deleteReq(ulid(), generateCsrfToken()));
    expect(res.status).toBe(401);
  });
});
