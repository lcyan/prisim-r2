// tests/unit/api/connections-route.test.ts
//
// Integration spec for /api/connections (root) and /api/connections/[id].
// Same "fat test" pattern as r2-presign-route.test.ts:
//   * real D1-shaped SQLite + real drizzle schema + real AES-GCM
//   * mocks at the outer boundaries — JWT, next-on-pages env, R2 control plane
//
// What this suite proves end-to-end:
//   - POST: creds rejected by R2 → 400 connection.invalid_credentials, no
//     access-key fragment in the response or audit row
//   - POST: success persists encrypted blobs (NOT plaintext) and writes a
//     connection.create audit row
//   - GET: returns ONLY masked summary fields (no ciphertext / iv / secret)
//   - PATCH: only `name` can be changed; extra fields → 400; rename of
//     someone else's record → 404, no row mutated
//   - DELETE: blocked 409 when an unexpired share exists; succeeds when the
//     share is already expired; success writes connection.delete audit

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
import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import { ApiErrorCode } from "@/lib/api/errors";

// Deterministic 32-byte master key. Same convention as the presign suite.
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(2)).toString(
  "base64",
);

const VALID_ACCOUNT_ID = "a".repeat(32);
const VALID_ACCESS_KEY = "AKIA-TEST-ACCESS-KEY-1234"; // >= 20 chars
const VALID_SECRET_KEY = "secret-key-with-at-least-forty-characters!!"; // >= 40 chars

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

// R2 control-plane mock: tests toggle `listBucketsImpl` per case to drive
// the success / R2CredentialError / generic-upstream branches. Importing
// the real R2CredentialError class keeps `instanceof` checks honest.
import { R2CredentialError } from "@/lib/r2/errors";
const listBucketsImpl = vi.fn();
vi.mock("@/lib/r2/control", () => ({
  listBuckets: (...args: unknown[]) => listBucketsImpl(...args),
}));

// makeS3Client validates non-empty strings — every call from the route has
// them, so a no-op stub is enough. We keep it explicit so a future change
// that adds DNS-style validation can't silently break unit tests.
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

// vi.mock is hoisted; route imports MUST come after.
import { POST as connectionsPOST, GET as connectionsGET } from "@/app/api/connections/route";
import {
  PATCH as connectionPATCH,
  DELETE as connectionDELETE,
} from "@/app/api/connections/[id]/route";

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

/** Seed a user + active session and wire fakeJwt to identify as them. */
async function seedUser(): Promise<{
  userId: string;
  csrfToken: string;
  sessionToken: string;
}> {
  const userId = ulid();
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

  fakeSessionStore.set(sessionToken, {
    csrfTokenHash,
    userId,
    email: `${userId}@test.local`,
  });
  fakeJwt.token = { userId, sessionToken, csrfToken };
  return { userId, csrfToken, sessionToken };
}

/** Insert a connection row directly (bypassing POST) — used by GET/PATCH/
 *  DELETE specs that don't need to exercise the create path. */
function seedConnection(userId: string, name = "test-conn"): string {
  const id = ulid();
  const nowSec = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      `INSERT INTO connections
       (id, user_id, name, account_id, endpoint, access_key_masked,
        access_key_ciphertext, access_key_iv,
        secret_key_ciphertext, secret_key_iv, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      name,
      VALID_ACCOUNT_ID,
      `https://${VALID_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      "AKIA****1234",
      Buffer.from([1, 2, 3]),
      Buffer.from([4, 5, 6]),
      Buffer.from([7, 8, 9]),
      Buffer.from([10, 11, 12]),
      nowSec,
    );
  return id;
}

function jsonReq(
  method: string,
  url: string,
  body: unknown,
  csrfToken: string,
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: csrfToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{
  id?: string;
  name?: string;
  accountId?: string;
  accessKeyMasked?: string;
  createdAt?: number;
  lastUsedAt?: number | null;
  ok?: boolean;
  error?: { code: string; message: string; requestId: string; details?: unknown };
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

describe("POST /api/connections — create", () => {
  it("rejects unknown extra fields (strict schema → validation.invalid)", async () => {
    const { csrfToken } = await seedUser();
    const res = await connectionsPOST(
      jsonReq(
        "POST",
        "https://x/api/connections",
        {
          name: "test",
          accountId: VALID_ACCOUNT_ID,
          accessKeyId: VALID_ACCESS_KEY,
          secretAccessKey: VALID_SECRET_KEY,
          // Should be rejected by the strict object schema.
          endpoint: "https://attacker.example/r2",
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.ValidationInvalid);
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });

  it("rejects bad accountId format with 400 (32 hex)", async () => {
    const { csrfToken } = await seedUser();
    const res = await connectionsPOST(
      jsonReq(
        "POST",
        "https://x/api/connections",
        {
          name: "test",
          accountId: "NOT-HEX",
          accessKeyId: VALID_ACCESS_KEY,
          secretAccessKey: VALID_SECRET_KEY,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });

  it("returns 400 connection.invalid_credentials when R2 rejects the key (no key fragment leaks)", async () => {
    listBucketsImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, csrfToken } = await seedUser();
    const res = await connectionsPOST(
      jsonReq(
        "POST",
        "https://x/api/connections",
        {
          name: "test",
          accountId: VALID_ACCOUNT_ID,
          accessKeyId: VALID_ACCESS_KEY,
          secretAccessKey: VALID_SECRET_KEY,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.ConnectionInvalidCredentials);

    // No fragment of the access key (first 4, last 4, or full) appears
    // in the serialized error payload. The masked form is also absent
    // because we don't echo back the input on this path at all.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(VALID_ACCESS_KEY);
    expect(wire).not.toContain(VALID_ACCESS_KEY.slice(0, 4));
    expect(wire).not.toContain(VALID_ACCESS_KEY.slice(-4));
    expect(wire).not.toContain(VALID_SECRET_KEY);

    // DB has no connection row — failed probe never persists.
    const count = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM connections WHERE user_id = ?`)
      .get(userId) as { n: number };
    expect(count.n).toBe(0);

    // Audit row exists with the failure status and NO secret-derived data.
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "connection.create",
      status: "failure",
      connection_id: null,
    });
    const auditWire = JSON.stringify(rows);
    expect(auditWire).not.toContain(VALID_ACCESS_KEY.slice(0, 4));
    expect(auditWire).not.toContain(VALID_ACCESS_KEY.slice(-4));
  });

  it("creates the connection on success — encrypts plaintext, response carries masked only", async () => {
    listBucketsImpl.mockResolvedValueOnce([]);
    const { userId, csrfToken } = await seedUser();
    const res = await connectionsPOST(
      jsonReq(
        "POST",
        "https://x/api/connections",
        {
          name: "prod",
          accountId: VALID_ACCOUNT_ID,
          accessKeyId: VALID_ACCESS_KEY,
          secretAccessKey: VALID_SECRET_KEY,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toMatch(/^\/api\/connections\/[0-9A-HJKMNP-TV-Z]{26}$/);
    const body = await readJson(res);
    expect(body.name).toBe("prod");
    expect(body.accountId).toBe(VALID_ACCOUNT_ID);
    expect(body.accessKeyMasked).toBe("AKIA****1234");
    expect(body.lastUsedAt).toBeNull();

    // No raw key in response — masked only.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(VALID_ACCESS_KEY);
    expect(wire).not.toContain(VALID_SECRET_KEY);

    // DB row holds ciphertext blobs (NOT plaintext) and the correct masked value.
    const row = sqlite
      .prepare(
        `SELECT name, account_id, endpoint, access_key_masked,
                access_key_ciphertext, access_key_iv,
                secret_key_ciphertext, secret_key_iv
         FROM connections WHERE user_id = ?`,
      )
      .get(userId) as {
      name: string;
      account_id: string;
      endpoint: string;
      access_key_masked: string;
      access_key_ciphertext: Buffer;
      access_key_iv: Buffer;
      secret_key_ciphertext: Buffer;
      secret_key_iv: Buffer;
    };
    expect(row.name).toBe("prod");
    expect(row.endpoint).toBe(`https://${VALID_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(row.access_key_masked).toBe("AKIA****1234");
    // Bytes should NOT contain the literal access key / secret key.
    expect(row.access_key_ciphertext.toString("utf8")).not.toContain(VALID_ACCESS_KEY);
    expect(row.secret_key_ciphertext.toString("utf8")).not.toContain(VALID_SECRET_KEY);
    // IV is the GCM nonce — 12 bytes per encryptCredential.
    expect(row.access_key_iv.length).toBe(12);
    expect(row.secret_key_iv.length).toBe(12);

    // Audit: one success row tied to the new connection_id.
    const audits = auditRowsForUser(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      op: "connection.create",
      status: "success",
      connection_id: body.id,
    });
  });

  it("rejects POST without a matching CSRF token (401 csrf.invalid) — never probes R2", async () => {
    await seedUser();
    const res = await connectionsPOST(
      jsonReq(
        "POST",
        "https://x/api/connections",
        {
          name: "x",
          accountId: VALID_ACCOUNT_ID,
          accessKeyId: VALID_ACCESS_KEY,
          secretAccessKey: VALID_SECRET_KEY,
        },
        // Mismatched CSRF token.
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
    expect(listBucketsImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/connections — list", () => {
  it("returns only this user's connections with masked fields", async () => {
    // User A owns two connections; user B is logged in with one.
    const otherUserId = ulid();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', ?)`,
      )
      .run(otherUserId, `${otherUserId}@test.local`, Math.floor(Date.now() / 1000));
    seedConnection(otherUserId, "userA-conn");
    seedConnection(otherUserId, "userA-conn-2");

    const { userId } = await seedUser();
    seedConnection(userId, "my-conn");

    const res = await connectionsGET(new Request("https://x/api/connections"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      accountId: string;
      accessKeyMasked: string;
      [k: string]: unknown;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.name).toBe("my-conn");
    // Sanity: the response is purely the safe summary shape; the row's
    // blob fields don't appear in serialization.
    const keys = Object.keys(body[0] ?? {}).sort();
    expect(keys).toEqual(
      ["accessKeyMasked", "accountId", "createdAt", "id", "lastUsedAt", "name"].sort(),
    );
  });

  it("returns 401 without a session (no enumeration without auth)", async () => {
    // No seedUser → fakeJwt.token stays null.
    const res = await connectionsGET(new Request("https://x/api/connections"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/connections/[id] — rename only", () => {
  it("updates name and returns the masked summary", async () => {
    const { userId, csrfToken } = await seedUser();
    const id = seedConnection(userId, "old-name");
    const res = await connectionPATCH(
      jsonReq(
        "PATCH",
        `https://x/api/connections/${id}`,
        { name: "new-name" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.name).toBe("new-name");
    expect(body.accessKeyMasked).toBe("AKIA****1234");

    const audits = auditRowsForUser(userId).filter(
      (r) => r.op === "connection.update",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.status).toBe("success");
  });

  it("rejects extra fields (e.g. attempted accountId change) with 400", async () => {
    const { userId, csrfToken } = await seedUser();
    const id = seedConnection(userId, "old");
    const res = await connectionPATCH(
      jsonReq(
        "PATCH",
        `https://x/api/connections/${id}`,
        { name: "ok", accountId: "b".repeat(32) },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.ValidationInvalid);

    // Row is unchanged — name stays "old" and accountId untouched.
    const row = sqlite
      .prepare(`SELECT name, account_id FROM connections WHERE id = ?`)
      .get(id) as { name: string; account_id: string };
    expect(row.name).toBe("old");
    expect(row.account_id).toBe(VALID_ACCOUNT_ID);
  });

  it("returns 404 (not 403) when renaming another user's connection — no row mutation", async () => {
    // User A's connection.
    const otherUserId = ulid();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', ?)`,
      )
      .run(otherUserId, `${otherUserId}@test.local`, Math.floor(Date.now() / 1000));
    const targetId = seedConnection(otherUserId, "victim");

    // User B logs in and tries to rename it.
    const { csrfToken } = await seedUser();
    const res = await connectionPATCH(
      jsonReq(
        "PATCH",
        `https://x/api/connections/${targetId}`,
        { name: "hijacked" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(404);

    // Victim's row is untouched.
    const row = sqlite
      .prepare(`SELECT name FROM connections WHERE id = ?`)
      .get(targetId) as { name: string };
    expect(row.name).toBe("victim");
  });
});

describe("DELETE /api/connections/[id] — share dependency check", () => {
  it("blocks with 409 connection.in_use when an unexpired share exists", async () => {
    const { userId, csrfToken } = await seedUser();
    const id = seedConnection(userId, "with-share");

    // Add a share that expires in the future.
    const future = Math.floor((Date.now() + 60_000) / 1000);
    sqlite
      .prepare(
        `INSERT INTO shares (id, user_id, connection_id, bucket, object_key,
                             url_hash, ttl_seconds, expires_at, created_at)
         VALUES (?, ?, ?, 'buk', 'k', 'h', 60, ?, ?)`,
      )
      .run(
        ulid(),
        userId,
        id,
        future,
        Math.floor(Date.now() / 1000),
      );

    const res = await connectionDELETE(
      jsonReq("DELETE", `https://x/api/connections/${id}`, undefined, csrfToken),
    );
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.ConnectionInUse);
    expect((body.error?.details as { activeShares?: number })?.activeShares).toBe(1);

    // Connection still exists.
    const present = sqlite
      .prepare(`SELECT id FROM connections WHERE id = ?`)
      .get(id);
    expect(present).toBeTruthy();
  });

  it("deletes when only expired shares exist; cascades remove them", async () => {
    const { userId, csrfToken } = await seedUser();
    const id = seedConnection(userId, "expirable");

    // Past expiry — should not block deletion.
    const past = Math.floor((Date.now() - 60_000) / 1000);
    sqlite
      .prepare(
        `INSERT INTO shares (id, user_id, connection_id, bucket, object_key,
                             url_hash, ttl_seconds, expires_at, created_at)
         VALUES (?, ?, ?, 'buk', 'k', 'h', 60, ?, ?)`,
      )
      .run(ulid(), userId, id, past, past);

    const res = await connectionDELETE(
      jsonReq("DELETE", `https://x/api/connections/${id}`, undefined, csrfToken),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).ok).toBe(true);

    // Row gone and dependent share cascaded away.
    const present = sqlite
      .prepare(`SELECT id FROM connections WHERE id = ?`)
      .get(id);
    expect(present).toBeUndefined();
    const shareCount = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM shares WHERE connection_id = ?`)
      .get(id) as { n: number };
    expect(shareCount.n).toBe(0);

    const audits = auditRowsForUser(userId).filter(
      (r) => r.op === "connection.delete",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.status).toBe("success");
  });

  it("returns 404 when deleting another user's connection", async () => {
    const otherUserId = ulid();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'h', ?)`,
      )
      .run(otherUserId, `${otherUserId}@test.local`, Math.floor(Date.now() / 1000));
    const victimId = seedConnection(otherUserId, "victim");

    const { csrfToken } = await seedUser();
    const res = await connectionDELETE(
      jsonReq("DELETE", `https://x/api/connections/${victimId}`, undefined, csrfToken),
    );
    expect(res.status).toBe(404);
    expect(
      sqlite
        .prepare(`SELECT id FROM connections WHERE id = ?`)
        .get(victimId),
    ).toBeTruthy();
  });
});
