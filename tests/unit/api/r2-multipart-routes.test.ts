// tests/unit/api/r2-multipart-routes.test.ts
//
// Integration spec for the three multipart control-plane routes:
//   POST /api/r2/multipart/create
//   POST /api/r2/multipart/complete
//   POST /api/r2/multipart/abort
//
// Same fat-test pattern as r2-list-route.test.ts and r2-presign-route.test.ts:
// real D1-shaped SQLite + real drizzle schema + real AES-GCM crypto. The R2
// SDK boundary is the only thing stubbed, so a regression that drops the
// userId AND-clause from the connection SELECT, mis-orders the parts list,
// or skips the audit row is caught here.
//
// What the three routes share (covered once via the create suite):
//   - withApi wiring: requireSession → requireCsrf → rate-limit → handler.
//   - User-scoped connection lookup: cross-user cid → 404 with no leakage.
//   - AES-GCM decrypt with AAD=cid; ciphertext tamper → 500 +
//     security.decrypt_failed audit row.
//   - R2CredentialError → 401 (R2 keys, not our session) with op-specific
//     failure audit row.
//   - writeOnlyByUser rate limit: write-aggregate budget enforced at 600/min.
//
// What's route-specific (covered per route):
//   - create: returns { uploadId }; forwards contentType into the SDK call.
//   - complete: returns { etag, location }; parts are passed through to the
//     control wrapper (which is responsible for sorting).
//   - abort: returns 204 with no body; SDK called exactly once.

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

// Deterministic 32-byte master key. 0x07 keeps these visually distinct from
// the other route suites (0x01 presign, 0x02 connections, 0x03 buckets,
// 0x05 list) if a grep across the corpus is ever helpful.
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64",
);

const FAKE_ACCESS_KEY = "AKIA-MULTIPART-TEST-KEY";
const FAKE_SECRET_KEY = "MULTIPART-FAKE-SECRET-KEY-XYZ";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

// Mock the R2 control plane. One vi.fn per wrapper so we can drive each
// route's happy path + failure cases independently and assert on the
// exact params passed into the SDK call.
const createMultipartImpl = vi.fn();
const completeMultipartImpl = vi.fn();
const abortMultipartImpl = vi.fn();
vi.mock("@/lib/r2/control", () => ({
  createMultipartUpload: (...args: unknown[]) => createMultipartImpl(...args),
  completeMultipartUpload: (...args: unknown[]) => completeMultipartImpl(...args),
  abortMultipartUpload: (...args: unknown[]) => abortMultipartImpl(...args),
}));

// makeS3Client validates non-empty strings — every call from the routes has
// them, so a no-op stub is enough.
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
    // Route + audit log both go through getDb(); a single drizzle instance
    // keeps every read/write on the same SQLite handle.
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
import { R2CredentialError } from "@/lib/r2/errors";
import { POST as createPOST } from "@/app/api/r2/multipart/create/route";
import { POST as completePOST } from "@/app/api/r2/multipart/complete/route";
import { POST as abortPOST } from "@/app/api/r2/multipart/abort/route";

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
       VALUES (?, ?, 'mp-test', 'acct-fake',
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

/** Build a POST request with CSRF header. Body is JSON.stringify'd. */
function mpReq(
  pathSuffix: "create" | "complete" | "abort",
  body: unknown,
  csrfToken: string,
): Request {
  return new Request(`https://x/api/r2/multipart/${pathSuffix}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: csrfToken,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{
  uploadId?: string;
  etag?: string | null;
  location?: string | null;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?: { policy?: string } & Record<string, unknown>;
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
}> {
  return sqlite
    .prepare(
      `SELECT op, status, connection_id, bucket, object_key
       FROM audit_log WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as Array<{
    op: string;
    status: string;
    connection_id: string | null;
    bucket: string | null;
    object_key: string | null;
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
  createMultipartImpl.mockReset();
  completeMultipartImpl.mockReset();
  abortMultipartImpl.mockReset();
});

/* ────────────────── create ────────────────── */

describe("POST /api/r2/multipart/create — happy path", () => {
  it("returns { uploadId } and forwards bucket/key/contentType to the SDK", async () => {
    createMultipartImpl.mockResolvedValueOnce({ uploadId: "upload-abc-123" });
    const { cid, csrfToken } = await seedUserAndConnection();

    const res = await createPOST(
      mpReq(
        "create",
        {
          cid,
          bucket: "my-bucket",
          key: "big/blob.bin",
          contentType: "application/octet-stream",
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toEqual({ uploadId: "upload-abc-123" });

    expect(createMultipartImpl).toHaveBeenCalledOnce();
    const call = createMultipartImpl.mock.calls[0]![0] as {
      bucket: string;
      key: string;
      contentType?: string;
    };
    expect(call.bucket).toBe("my-bucket");
    expect(call.key).toBe("big/blob.bin");
    expect(call.contentType).toBe("application/octet-stream");
  });

  it("works without contentType (passes undefined through)", async () => {
    createMultipartImpl.mockResolvedValueOnce({ uploadId: "upload-1" });
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      mpReq(
        "create",
        { cid, bucket: "my-bucket", key: "big.bin" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const call = createMultipartImpl.mock.calls[0]![0] as {
      contentType?: string;
    };
    expect(call.contentType).toBeUndefined();
  });

  it("writes an upload.create success audit row tied to the connection", async () => {
    createMultipartImpl.mockResolvedValueOnce({ uploadId: "u-1" });
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    await createPOST(
      mpReq("create", { cid, bucket: "my-bucket", key: "k" }, csrfToken),
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upload.create",
      status: "success",
      bucket: "my-bucket",
      object_key: "k",
      connection_id: cid,
    });
  });
});

describe("POST /api/r2/multipart/create — validation", () => {
  it("rejects an unknown extra field (strict schema)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      mpReq(
        "create",
        { cid, bucket: "my-bucket", key: "k", rogue: "x" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
    expect(createMultipartImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-ULID cid with 400", async () => {
    const { csrfToken } = await seedUserAndConnection();
    const res = await createPOST(
      mpReq(
        "create",
        { cid: "not-a-ulid", bucket: "my-bucket", key: "k" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect(createMultipartImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/r2/multipart/create — authorization & error paths", () => {
  it("returns 404 (not 403) when cid belongs to another user — no enumeration", async () => {
    const userA = await seedUserAndConnection({ loginAs: false });
    const userB = await seedUserAndConnection({ loginAs: true });
    const res = await createPOST(
      mpReq(
        "create",
        { cid: userA.cid, bucket: "my-bucket", key: "k" },
        userB.csrfToken,
      ),
    );
    expect(res.status).toBe(404);
    // The victim's connection was never touched.
    expect(auditRowsForUser(userA.userId)).toHaveLength(0);
    expect(createMultipartImpl).not.toHaveBeenCalled();
  });

  it("rejects requests without a session (401 auth.unauthorized)", async () => {
    const res = await createPOST(
      mpReq(
        "create",
        { cid: ulid(), bucket: "my-bucket", key: "k" },
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );
  });

  it("rejects POST without a matching X-CSRF-Token (401 csrf.invalid)", async () => {
    const { cid } = await seedUserAndConnection();
    const res = await createPOST(
      mpReq(
        "create",
        { cid, bucket: "my-bucket", key: "k" },
        // Mismatched token — seeded csrfToken differs from this one.
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
    expect(createMultipartImpl).not.toHaveBeenCalled();
  });

  it("decrypt failure → 500 + security.decrypt_failed audit", async () => {
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    // Corrupt the access-key ciphertext so AES-GCM tag verification fails.
    sqlite
      .prepare(`UPDATE connections SET access_key_ciphertext = ? WHERE id = ?`)
      .run(Buffer.from(new Uint8Array(48).fill(0xff)), cid);

    const res = await createPOST(
      mpReq("create", { cid, bucket: "my-bucket", key: "k" }, csrfToken),
    );
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
    expect(createMultipartImpl).not.toHaveBeenCalled();
  });

  it("R2CredentialError → 401 + upload.create failure audit", async () => {
    createMultipartImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid, csrfToken } = await seedUserAndConnection();

    const res = await createPOST(
      mpReq("create", { cid, bucket: "my-bucket", key: "k" }, csrfToken),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.AuthUnauthorized,
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upload.create",
      status: "failure",
    });
  });
});

/* ────────────────── complete ────────────────── */

describe("POST /api/r2/multipart/complete — happy path", () => {
  it("returns { etag, location } and forwards parts to the SDK as-given", async () => {
    completeMultipartImpl.mockResolvedValueOnce({
      etag: '"abc-2"',
      location: "https://r2.example/my-bucket/big.bin",
    });
    const { cid, csrfToken } = await seedUserAndConnection();

    const parts = [
      { partNumber: 3, etag: '"e3"' },
      { partNumber: 1, etag: '"e1"' },
      { partNumber: 2, etag: '"e2"' },
    ];
    const res = await completePOST(
      mpReq(
        "complete",
        {
          cid,
          bucket: "my-bucket",
          key: "big.bin",
          uploadId: "upload-abc",
          parts,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      etag: '"abc-2"',
      location: "https://r2.example/my-bucket/big.bin",
    });

    // Parts are forwarded verbatim — the control wrapper handles sorting.
    // Asserting unsorted here documents that the route doesn't pre-sort and
    // would catch a future change that surprisingly mutated/sorted the
    // payload before passing it on.
    expect(completeMultipartImpl).toHaveBeenCalledOnce();
    const call = completeMultipartImpl.mock.calls[0]![0] as {
      bucket: string;
      key: string;
      uploadId: string;
      parts: Array<{ partNumber: number; etag: string }>;
    };
    expect(call.bucket).toBe("my-bucket");
    expect(call.key).toBe("big.bin");
    expect(call.uploadId).toBe("upload-abc");
    expect(call.parts).toEqual(parts);
  });

  it("normalizes missing etag/location to null in the response", async () => {
    completeMultipartImpl.mockResolvedValueOnce({});
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await completePOST(
      mpReq(
        "complete",
        {
          cid,
          bucket: "my-bucket",
          key: "k",
          uploadId: "u",
          parts: [{ partNumber: 1, etag: '"e"' }],
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ etag: null, location: null });
  });

  it("writes an upload.complete success audit row", async () => {
    completeMultipartImpl.mockResolvedValueOnce({
      etag: '"e"',
      location: "https://x/y",
    });
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    await completePOST(
      mpReq(
        "complete",
        {
          cid,
          bucket: "my-bucket",
          key: "k",
          uploadId: "u",
          parts: [{ partNumber: 1, etag: '"e"' }],
        },
        csrfToken,
      ),
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upload.complete",
      status: "success",
      bucket: "my-bucket",
      object_key: "k",
    });
  });
});

describe("POST /api/r2/multipart/complete — validation", () => {
  it("rejects empty parts array with 400 (caught at the schema layer)", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await completePOST(
      mpReq(
        "complete",
        { cid, bucket: "my-bucket", key: "k", uploadId: "u", parts: [] },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
    expect(completeMultipartImpl).not.toHaveBeenCalled();
  });

  it("rejects missing uploadId with 400", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await completePOST(
      mpReq(
        "complete",
        {
          cid,
          bucket: "my-bucket",
          key: "k",
          parts: [{ partNumber: 1, etag: '"e"' }],
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect(completeMultipartImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/r2/multipart/complete — error paths", () => {
  it("R2CredentialError → 401 + upload.complete failure audit", async () => {
    completeMultipartImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const res = await completePOST(
      mpReq(
        "complete",
        {
          cid,
          bucket: "my-bucket",
          key: "k",
          uploadId: "u",
          parts: [{ partNumber: 1, etag: '"e"' }],
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(401);
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upload.complete",
      status: "failure",
    });
  });
});

/* ────────────────── abort ────────────────── */

describe("POST /api/r2/multipart/abort — happy path", () => {
  it("returns 204 with no body and calls abortMultipartUpload exactly once", async () => {
    abortMultipartImpl.mockResolvedValueOnce(undefined);
    const { cid, csrfToken } = await seedUserAndConnection();

    const res = await abortPOST(
      mpReq(
        "abort",
        { cid, bucket: "my-bucket", key: "k", uploadId: "u" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/);

    expect(abortMultipartImpl).toHaveBeenCalledOnce();
    const call = abortMultipartImpl.mock.calls[0]![0] as {
      bucket: string;
      key: string;
      uploadId: string;
    };
    expect(call.bucket).toBe("my-bucket");
    expect(call.key).toBe("k");
    expect(call.uploadId).toBe("u");
  });

  it("writes an upload.abort success audit row", async () => {
    abortMultipartImpl.mockResolvedValueOnce(undefined);
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    await abortPOST(
      mpReq(
        "abort",
        { cid, bucket: "my-bucket", key: "k", uploadId: "u" },
        csrfToken,
      ),
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upload.abort",
      status: "success",
      bucket: "my-bucket",
      object_key: "k",
    });
  });
});

describe("POST /api/r2/multipart/abort — error paths", () => {
  it("R2CredentialError → 401 + upload.abort failure audit", async () => {
    abortMultipartImpl.mockRejectedValueOnce(new R2CredentialError());
    const { userId, cid, csrfToken } = await seedUserAndConnection();
    const res = await abortPOST(
      mpReq(
        "abort",
        { cid, bucket: "my-bucket", key: "k", uploadId: "u" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(401);
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upload.abort",
      status: "failure",
    });
  });
});

/* ────────────────── rate limit (shared) ──────────────────
 *
 * All three multipart routes use RateLimitBundles.writeOnlyByUser, which is
 * the 600/min write-aggregate budget. We assert it once on the abort route
 * (smallest happy path) and trust the others to behave identically — they
 * pass the same bundle into withApi. */

describe("POST /api/r2/multipart/* — rate limit", () => {
  it("returns 429 + Retry-After once the write-aggregate budget is exhausted", async () => {
    abortMultipartImpl.mockResolvedValue(undefined);
    const { userId, cid, csrfToken } = await seedUserAndConnection();

    // 600/min write-aggregate. Looping 600 sequential POSTs would be slow,
    // so we pre-seed the bucket to 599 (one slot left), then verify two
    // consecutive requests behave as 200-then-429. This exercises the same
    // limiter wiring without burning ~10s on a single test. Keep the
    // ratelimit shape in sync with RateLimitPolicies.writeAggregateByUser.
    sqlite
      .prepare(
        `INSERT INTO rate_limit_buckets (key, count, window_start)
         VALUES (?, ?, ?)`,
      )
      .run(`write:user:${userId}`, 599, Date.now());

    const makeReq = () =>
      mpReq(
        "abort",
        { cid, bucket: "my-bucket", key: "k", uploadId: "u" },
        csrfToken,
      );

    const allowed = await abortPOST(makeReq());
    expect(allowed.status).toBe(204);
    const denied = await abortPOST(makeReq());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = await readJson(denied);
    expect(body.error?.code).toBe(ApiErrorCode.RateLimited);
    expect(body.error?.details?.policy).toBe(`write:user:${userId}`);
  });
});
