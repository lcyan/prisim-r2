// tests/unit/api/r2-delete-routes.test.ts
//
// Integration spec for the two-step destructive delete flow:
//   POST /api/r2/delete/prepare  (mint confirmToken)
//   POST /api/r2/delete          (verify token + run deleteObjects)
//
// Same fat-test pattern as r2-multipart-routes.test.ts: real D1-shaped
// SQLite + real drizzle schema + real AES-GCM crypto + real HMAC delete
// token. The only stub is the R2 control plane — that way the tests catch:
//   * skipping the user_id AND-clause on the connection SELECT (cross-user
//     enumeration)
//   * forgetting to verify the confirmToken before doing the delete (the
//     core security invariant of this flow)
//   * sending the wrong keys list at confirm time (replay across triples)
//   * mis-recording the audit row's status on partial-failure responses
//
// What's prepared-specific:
//   * No R2 call. No decrypt. No audit row on prepare. The route is cheap
//     so it can survive a high-volume "open then cancel" pattern.
//
// What's delete-specific:
//   * Token verify must happen BEFORE the connection lookup (cheap reject).
//   * audit row is written ONCE per request, status reflects whether ALL
//     keys deleted, errorMsg carries counts. We assert these against the
//     audit_log table directly.

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

// Deterministic 32-byte master key. 0x09 distinguishes from the other
// route suites (multipart=0x07, list=0x05, presign=0x01).
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString(
  "base64",
);
const AUTH_SECRET = "delete-route-test-auth-secret";

const FAKE_ACCESS_KEY = "AKIA-DELETE-TEST-KEY-ABC";
const FAKE_SECRET_KEY = "DELETE-TEST-FAKE-SECRET-KEY-XYZ";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

const deleteObjectsImpl = vi.fn();
vi.mock("@/lib/r2/control", () => ({
  deleteObjects: (...args: unknown[]) => deleteObjectsImpl(...args),
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

// vi.mock is hoisted; route + helper imports MUST come after.
import { R2CredentialError } from "@/lib/r2/errors";
import { POST as preparePOST } from "@/app/api/r2/delete/prepare/route";
import { POST as deletePOST } from "@/app/api/r2/delete/route";

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
       VALUES (?, ?, 'del-test', 'acct-fake',
               'https://acct-fake.r2.cloudflarestorage.com',
               'AKIA****XYZ', ?, ?, ?, ?, ?)`,
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

function delReq(
  pathSuffix: "prepare" | "confirm",
  body: unknown,
  csrfToken: string,
): Request {
  const url =
    pathSuffix === "prepare"
      ? "https://x/api/r2/delete/prepare"
      : "https://x/api/r2/delete";
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: csrfToken,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{
  confirmToken?: string;
  expiresAt?: number;
  deleted?: string[];
  errors?: Array<{ key?: string; code?: string; message?: string }>;
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

/** Common helper: walk the full prepare → confirm dance and return the token
 *  + parsed prepare body. Saves repeated boilerplate across the delete suite. */
async function obtainConfirmToken(args: {
  cid: string;
  bucket: string;
  keys: string[];
  csrfToken: string;
}): Promise<{ confirmToken: string; expiresAt: number }> {
  const res = await preparePOST(
    delReq(
      "prepare",
      { cid: args.cid, bucket: args.bucket, keys: args.keys },
      args.csrfToken,
    ),
  );
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(typeof body.confirmToken).toBe("string");
  expect(typeof body.expiresAt).toBe("number");
  return {
    confirmToken: body.confirmToken!,
    expiresAt: body.expiresAt!,
  };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);
  fakeJwt.token = null;
  fakeSessionStore.clear();
  deleteObjectsImpl.mockReset();
});

/* ────────────────── prepare ────────────────── */

describe("POST /api/r2/delete/prepare", () => {
  it("returns { confirmToken, expiresAt } with a future expiry", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await preparePOST(
      delReq(
        "prepare",
        { cid, bucket: "my-bucket", keys: ["a.txt", "b.txt"] },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.confirmToken).toMatch(/^[A-Za-z0-9_-]+\.\d+$/u);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("does NOT touch R2 (no decrypt, no deleteObjects call)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    await preparePOST(
      delReq(
        "prepare",
        { cid, bucket: "my-bucket", keys: ["a.txt"] },
        csrfToken,
      ),
    );
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("does NOT write an audit row on prepare alone", async () => {
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    await preparePOST(
      delReq(
        "prepare",
        { cid, bucket: "my-bucket", keys: ["a.txt"] },
        csrfToken,
      ),
    );
    expect(auditRowsForUser(userId)).toHaveLength(0);
  });

  it("returns 404 (not 403) when cid belongs to another user", async () => {
    const userA = await seedUserAndConnection({ loginAs: false });
    const userB = await seedUserAndConnection({ loginAs: true });
    const res = await preparePOST(
      delReq(
        "prepare",
        { cid: userA.cid, bucket: "my-bucket", keys: ["a.txt"] },
        userB.csrfToken,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("rejects empty keys array (schema: min 1)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await preparePOST(
      delReq("prepare", { cid, bucket: "my-bucket", keys: [] }, csrfToken),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
  });

  it("rejects an unknown extra field (strict schema)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await preparePOST(
      delReq(
        "prepare",
        { cid, bucket: "my-bucket", keys: ["a.txt"], rogue: 1 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects requests without a session (401)", async () => {
    const res = await preparePOST(
      delReq(
        "prepare",
        { cid: ulid(), bucket: "my-bucket", keys: ["a.txt"] },
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
  });

  it("rejects POST without a matching X-CSRF-Token (401)", async () => {
    const { cid } = await seedUserAndConnection();
    const res = await preparePOST(
      delReq(
        "prepare",
        { cid, bucket: "my-bucket", keys: ["a.txt"] },
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
  });
});

/* ────────────────── delete (confirm) ────────────────── */

describe("POST /api/r2/delete — happy path", () => {
  it("verifies the confirmToken and forwards keys to deleteObjects", async () => {
    deleteObjectsImpl.mockResolvedValueOnce({
      deleted: ["a.txt", "b.txt"],
      errors: [],
    });
    const { cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt", "b.txt"],
      csrfToken,
    });

    const res = await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["a.txt", "b.txt"], confirmToken },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.deleted).toEqual(["a.txt", "b.txt"]);
    expect(body.errors).toEqual([]);

    expect(deleteObjectsImpl).toHaveBeenCalledOnce();
    const call = deleteObjectsImpl.mock.calls[0]![0] as {
      bucket: string;
      keys: string[];
    };
    expect(call.bucket).toBe("my-bucket");
    expect(call.keys).toEqual(["a.txt", "b.txt"]);
  });

  it("writes ONE object.delete success audit row with the count", async () => {
    deleteObjectsImpl.mockResolvedValueOnce({
      deleted: ["a", "b", "c"],
      errors: [],
    });
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a", "b", "c"],
      csrfToken,
    });
    await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["a", "b", "c"], confirmToken },
        csrfToken,
      ),
    );

    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "object.delete",
      status: "success",
      bucket: "my-bucket",
      // No single key tracked for a multi-key request.
      object_key: null,
      connection_id: cid,
    });
    expect(rows[0]!.error_msg).toBe("3 key(s) deleted");
  });

  it("accepts keys in a different order than prepare saw (sort-stable hash)", async () => {
    deleteObjectsImpl.mockResolvedValueOnce({
      deleted: ["a", "b", "c"],
      errors: [],
    });
    const { cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a", "b", "c"],
      csrfToken,
    });
    // Re-order at confirm time — the HMAC binds sort(keys), so this MUST
    // still verify.
    const res = await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["c", "a", "b"], confirmToken },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/r2/delete — token verification", () => {
  it("rejects a token issued for a different keys list (412)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt", "b.txt"],
      csrfToken,
    });
    // Submit an extra key — keysHash changes, HMAC verify fails.
    const res = await deletePOST(
      delReq(
        "confirm",
        {
          cid,
          bucket: "my-bucket",
          keys: ["a.txt", "b.txt", "c.txt"],
          confirmToken,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(412);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ConfirmationRequired,
    );
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects a token issued for a different bucket (412)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt"],
      csrfToken,
    });
    const res = await deletePOST(
      delReq(
        "confirm",
        {
          cid,
          bucket: "other-bucket",
          keys: ["a.txt"],
          confirmToken,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(412);
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature half (412)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt"],
      csrfToken,
    });
    const dot = confirmToken.lastIndexOf(".");
    const sig = confirmToken.slice(0, dot);
    const swapped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const tampered = `${swapped}${confirmToken.slice(dot)}`;
    const res = await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["a.txt"], confirmToken: tampered },
        csrfToken,
      ),
    );
    expect(res.status).toBe(412);
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects a token forged with a longer exp (412)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt"],
      csrfToken,
    });
    const dot = confirmToken.lastIndexOf(".");
    const sig = confirmToken.slice(0, dot);
    const exp = Number(confirmToken.slice(dot + 1));
    // 1h in the future — HMAC compare fails because the signed payload
    // included the original exp, not exp+3600.
    const tampered = `${sig}.${exp + 3600}`;
    const res = await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["a.txt"], confirmToken: tampered },
        csrfToken,
      ),
    );
    expect(res.status).toBe(412);
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("rejects a token re-used across users (412)", async () => {
    // User A obtains a token for their connection's bucket. User B copies
    // the token and submits a delete on their own connection — the userId
    // in the signed payload mismatches, verify fails.
    const userA = await seedUserAndConnection({ loginAs: true });
    const { confirmToken } = await obtainConfirmToken({
      cid: userA.cid,
      bucket: "shared-bucket-name",
      keys: ["a.txt"],
      csrfToken: userA.csrfToken,
    });

    const userB = await seedUserAndConnection({ loginAs: true });
    const res = await deletePOST(
      delReq(
        "confirm",
        {
          cid: userB.cid,
          bucket: "shared-bucket-name",
          keys: ["a.txt"],
          confirmToken,
        },
        userB.csrfToken,
      ),
    );
    expect(res.status).toBe(412);
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("does NOT touch the DB lookup when the token check fails", async () => {
    // Pass a cid that doesn't exist; token-check failure should short-circuit
    // BEFORE the connection SELECT runs. The proof: we still get 412, not 404.
    const { csrfToken } = await seedUserAndConnection();
    const res = await deletePOST(
      delReq(
        "confirm",
        {
          cid: ulid(),
          bucket: "my-bucket",
          keys: ["a.txt"],
          confirmToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.9999999999",
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(412);
  });
});

describe("POST /api/r2/delete — failure paths", () => {
  it("decrypt failure → 500 + security.decrypt_failed audit row", async () => {
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt"],
      csrfToken,
    });
    // Corrupt the access-key ciphertext so AES-GCM tag verification fails.
    sqlite
      .prepare(`UPDATE connections SET access_key_ciphertext = ? WHERE id = ?`)
      .run(Buffer.from(new Uint8Array(48).fill(0xff)), cid);

    const res = await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["a.txt"], confirmToken },
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
    expect(deleteObjectsImpl).not.toHaveBeenCalled();
  });

  it("R2CredentialError → 401 + object.delete failure audit", async () => {
    deleteObjectsImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt"],
      csrfToken,
    });

    const res = await deletePOST(
      delReq(
        "confirm",
        { cid, bucket: "my-bucket", keys: ["a.txt"], confirmToken },
        csrfToken,
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "object.delete",
      status: "failure",
    });
  });

  it("partial-failure response: audit status='failure' with counts", async () => {
    deleteObjectsImpl.mockResolvedValueOnce({
      deleted: ["a.txt"],
      errors: [{ key: "b.txt", code: "AccessDenied", message: "nope" }],
    });
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const { confirmToken } = await obtainConfirmToken({
      cid,
      bucket: "my-bucket",
      keys: ["a.txt", "b.txt"],
      csrfToken,
    });

    const res = await deletePOST(
      delReq(
        "confirm",
        {
          cid,
          bucket: "my-bucket",
          keys: ["a.txt", "b.txt"],
          confirmToken,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.deleted).toEqual(["a.txt"]);
    expect(body.errors).toHaveLength(1);

    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "object.delete",
      status: "failure",
    });
    expect(rows[0]!.error_msg).toBe("1 deleted, 1 failed");
  });

  it("returns 404 (not 403) when cid belongs to another user", async () => {
    // Token-check must succeed first (correct user+bucket+keys), then
    // the connection lookup fails because the cid is someone else's.
    const userA = await seedUserAndConnection({ loginAs: false });
    const userB = await seedUserAndConnection({ loginAs: true });
    const { confirmToken } = await obtainConfirmToken({
      cid: userA.cid, // Note: prepare also validates user-scoped, so we
      // need a fresh prepare for userB. Use userB instead.
      bucket: "my-bucket",
      keys: ["a.txt"],
      // userA isn't logged in; this prepare will 401 — use userB.
      csrfToken: userB.csrfToken,
    }).catch(() => null) ?? { confirmToken: "" };

    // The simpler path: userB obtains a valid token for THEIR cid, then
    // swaps cid to userA's at confirm time. Token's payload is keyed by
    // userId, so HMAC still verifies (userB issued, userB confirming),
    // but the WHERE clause on (cid=userA.cid AND user_id=userB.id)
    // returns no row → 404.
    const userBToken = await obtainConfirmToken({
      cid: userB.cid,
      bucket: "my-bucket",
      keys: ["a.txt"],
      csrfToken: userB.csrfToken,
    });

    const res = await deletePOST(
      delReq(
        "confirm",
        {
          cid: userA.cid,
          bucket: "my-bucket",
          keys: ["a.txt"],
          confirmToken: userBToken.confirmToken,
        },
        userB.csrfToken,
      ),
    );
    expect(res.status).toBe(404);
    expect(auditRowsForUser(userA.userId)).toHaveLength(0);
    // Silence the suppressed-throw warning in some setups.
    void confirmToken;
  });
});
