// tests/unit/api/r2-presign-route.test.ts
//
// Integration spec for POST /api/r2/presign. This test owns the route
// contract end-to-end: validation → connection lookup → decrypt → presign →
// audit, plus the cross-cutting middleware behaviors (CSRF, rate limit,
// session scoping).
//
// Why this is a "fat" test (real DB, real crypto):
//   The route is the first layer where credentials are decrypted and the
//   first place a leak could happen. Stubbing crypto or DB out lets a real
//   regression slip past — e.g. a future PR that drops the `userId = ctx`
//   AND-clause from the connection SELECT would silently allow cross-user
//   presigns, and only a SQL-backed test catches that. Likewise for
//   AES-GCM AAD binding: we want a real ciphertext that would fail tag
//   verification on tamper.
//
// What IS stubbed:
//   - @aws-sdk/s3-request-presigner.getSignedUrl  → so we don't make a
//     real SigV4 round-trip and so we can simulate upstream errors.
//   - getRequestContext + auth adapter + JWT     → standard middleware
//     fixtures, identical pattern to middleware-rate-limit.test.ts.
//   - @/lib/db/client.getDb                       → returns a drizzle
//     instance wrapping the same in-memory SQLite that backs env.DB, so
//     rate-limit UPSERTs and connection SELECTs share state.

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

// Deterministic 32-byte master key (0x01 repeated) → 44-char base64.
// Using a fixed key keeps the test reproducible AND lets us verify that
// AAD binding (per-row, not per-key) is what actually scopes ciphertexts.
const ENCRYPTION_KEY_B64 = Buffer.from(new Uint8Array(32).fill(1)).toString(
  "base64",
);

// Plausible-looking creds. The route never inspects their format; only
// makeS3Client does, and that's stubbed away by mocking getSignedUrl.
const FAKE_ACCESS_KEY = "AKIAFAKEACCESSKEY12";
const FAKE_SECRET_KEY = "FAKE_SECRET_KEY_FOR_TESTS_BLAH";

// Cross-test singletons (the vi.mock factories close over these refs).
type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;
const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
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

// Imports MUST come after vi.mock — Vitest hoists vi.mock calls above
// regular imports, but only relative-to-the-current-module. Importing the
// route here picks up the mocked dependencies.
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { POST } from "@/app/api/r2/presign/route";

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

/** D1-shape facade over better-sqlite3 for the rate limiter's raw UPSERT. */
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
 *  everything the test needs to call POST as that user. Caller can pass
 *  `loginAs` to also wire the JWT/session — multi-user tests prefer to
 *  defer this so they can switch identities. */
async function seedUserAndConnection(opts: {
  loginAs?: boolean;
} = {}): Promise<{
  userId: string;
  cid: string;
  csrfToken: string;
  sessionToken: string;
}> {
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
       VALUES (?, ?, 'test', 'acct-fake', 'https://acct-fake.r2.cloudflarestorage.com',
               'AKIA****KEY1', ?, ?, ?, ?, ?)`,
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
    fakeJwt.token = {
      userId,
      sessionToken,
      csrfToken,
    };
  }
  return { userId, cid, csrfToken, sessionToken };
}

function presignReq(body: unknown, csrfToken: string): Request {
  return new Request("https://x/api/r2/presign", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CSRF_HEADER_NAME]: csrfToken,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<{
  url?: string;
  expiresAt?: number;
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
  bucket: string | null;
  object_key: string | null;
}> {
  return sqlite
    .prepare(
      `SELECT op, status, bucket, object_key
       FROM audit_log WHERE user_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as Array<{
    op: string;
    status: string;
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
  vi.mocked(getSignedUrl).mockReset();
});

describe("POST /api/r2/presign — happy paths per op", () => {
  it("put → returns presigned URL and a future expiresAt", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://r2.example/put-signed");
    const { cid, csrfToken } = await seedUserAndConnection();

    const start = Date.now();
    const res = await POST(
      presignReq({ op: "put", cid, bucket: "my-bucket", key: "f.bin" }, csrfToken),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.url).toBe("https://r2.example/put-signed");
    expect(typeof body.expiresAt).toBe("number");
    // Default ttl = 900s; expiresAt should be ~now + 15min.
    expect(body.expiresAt!).toBeGreaterThanOrEqual(start + 899_000);
    expect(body.expiresAt!).toBeLessThanOrEqual(Date.now() + 901_000);
  });

  it("get → returns presigned URL", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://r2.example/get-signed");
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await POST(
      presignReq({ op: "get", cid, bucket: "my-bucket", key: "f.bin" }, csrfToken),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).url).toBe("https://r2.example/get-signed");
  });

  it("upload-part → returns presigned URL", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://r2.example/part-signed");
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await POST(
      presignReq(
        {
          op: "upload-part",
          cid,
          bucket: "my-bucket",
          key: "big.bin",
          uploadId: "upload-abc",
          partNumber: 3,
        },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    expect((await readJson(res)).url).toBe("https://r2.example/part-signed");
  });

  it("honors caller-supplied ttl in expiresAt", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://r2.example/x");
    const { cid, csrfToken } = await seedUserAndConnection();
    const start = Date.now();
    const res = await POST(
      presignReq(
        { op: "get", cid, bucket: "my-bucket", key: "f.bin", ttl: 60 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.expiresAt!).toBeGreaterThanOrEqual(start + 59_000);
    expect(body.expiresAt!).toBeLessThanOrEqual(Date.now() + 61_000);
  });
});

describe("POST /api/r2/presign — validation", () => {
  it("rejects ttl > 7200 with 400 validation.invalid", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await POST(
      presignReq(
        { op: "get", cid, bucket: "buk", key: "k", ttl: 7201 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe(
      ApiErrorCode.ValidationInvalid,
    );
    // No signing was attempted — validation runs before the handler.
    expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
  });

  it("rejects upload-part missing uploadId/partNumber with 400", async () => {
    const { cid, csrfToken } = await seedUserAndConnection();
    const res = await POST(
      presignReq(
        { op: "upload-part", cid, bucket: "buk", key: "k", partNumber: 1 },
        csrfToken,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/r2/presign — authorization & scoping", () => {
  it("returns 404 when the connection does not exist for this user", async () => {
    const { csrfToken } = await seedUserAndConnection();
    // A valid-format ULID that does NOT exist in the table.
    const nonExistentCid = ulid();
    const res = await POST(
      presignReq(
        { op: "put", cid: nonExistentCid, bucket: "buk", key: "k" },
        csrfToken,
      ),
    );
    expect(res.status).toBe(404);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.NotFound);
  });

  it("returns 404 (not 403) when cid belongs to another user (no enumeration)", async () => {
    // User A's connection.
    const userA = await seedUserAndConnection({ loginAs: false });
    // User B is logged in.
    const userB = await seedUserAndConnection({ loginAs: true });
    const res = await POST(
      presignReq(
        { op: "get", cid: userA.cid, bucket: "buk", key: "k" },
        userB.csrfToken,
      ),
    );
    expect(res.status).toBe(404);
    // And user B's request never touched user A's connection in the audit log.
    expect(auditRowsForUser(userA.userId)).toHaveLength(0);
  });
});

describe("POST /api/r2/presign — audit logging", () => {
  it("writes one audit row per successful put (op=presign.put)", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://x");
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    await POST(
      presignReq({ op: "put", cid, bucket: "buk", key: "k" }, csrfToken),
    );
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "presign.put",
      status: "success",
      bucket: "buk",
      object_key: "k",
    });
  });

  it("writes presign.get for get op", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://x");
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    await POST(
      presignReq({ op: "get", cid, bucket: "buk", key: "k" }, csrfToken),
    );
    expect(auditRowsForUser(userId)[0]).toMatchObject({
      op: "presign.get",
      status: "success",
    });
  });

  it("writes presign.put for upload-part (audit codebook stays narrow)", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://x");
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    await POST(
      presignReq(
        {
          op: "upload-part",
          cid,
          bucket: "buk",
          key: "k",
          uploadId: "u",
          partNumber: 1,
        },
        csrfToken,
      ),
    );
    expect(auditRowsForUser(userId)[0]?.op).toBe("presign.put");
  });

  it("does NOT persist the presigned URL anywhere in the audit row", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue(
      "https://r2.example/SECRET-SIGNATURE",
    );
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    await POST(
      presignReq({ op: "get", cid, bucket: "buk", key: "k" }, csrfToken),
    );
    const allRows = sqlite
      .prepare(`SELECT * FROM audit_log WHERE user_id = ?`)
      .all(userId) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(allRows);
    expect(serialized).not.toContain("SECRET-SIGNATURE");
    expect(serialized).not.toContain("r2.example");
  });
});

describe("POST /api/r2/presign — error paths", () => {
  it("decrypt failure → 500 + security.decrypt_failed audit row", async () => {
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    // Corrupt the access-key ciphertext so AES-GCM tag verification fails.
    sqlite
      .prepare(`UPDATE connections SET access_key_ciphertext = ? WHERE id = ?`)
      .run(Buffer.from(new Uint8Array(48).fill(0xff)), cid);

    const res = await POST(
      presignReq({ op: "get", cid, bucket: "buk", key: "k" }, csrfToken),
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
    // No presigning should have been attempted.
    expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
  });

  it("R2 returning InvalidAccessKeyId → 401 + audit presign.put failure", async () => {
    vi.mocked(getSignedUrl).mockRejectedValue(
      Object.assign(new Error("upstream"), { name: "InvalidAccessKeyId" }),
    );
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    const res = await POST(
      presignReq({ op: "put", cid, bucket: "buk", key: "k" }, csrfToken),
    );
    expect(res.status).toBe(401);
    // Failure audited with the op the user attempted, not security.decrypt_failed.
    const rows = auditRowsForUser(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "presign.put",
      status: "failure",
    });
  });
});

describe("POST /api/r2/presign — rate limit", () => {
  it("returns 429 + Retry-After on the 61st presign within the same window", async () => {
    vi.mocked(getSignedUrl).mockResolvedValue("https://x");
    const { cid, csrfToken, userId } = await seedUserAndConnection();
    const makeReq = () =>
      presignReq({ op: "get", cid, bucket: "buk", key: "k" }, csrfToken);

    // The presign-per-user policy is 60/min. The first 60 succeed.
    for (let i = 0; i < 60; i++) {
      const res = await POST(makeReq());
      if (res.status !== 200) {
        throw new Error(`unexpected status at i=${i}: ${res.status}`);
      }
    }

    const denied = await POST(makeReq());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = await readJson(denied);
    expect(body.error?.code).toBe(ApiErrorCode.RateLimited);
    expect(body.error?.details?.policy).toBe(`presign:user:${userId}`);

    // The denied request never reached the handler, so the audit count
    // matches the 60 successful presigns — not 61.
    expect(auditRowsForUser(userId)).toHaveLength(60);
  });
});

describe("POST /api/r2/presign — auth & CSRF", () => {
  it("rejects requests without a session (401 auth.unauthorized)", async () => {
    // fakeJwt.token stays null from beforeEach.
    const res = await POST(
      presignReq(
        {
          op: "put",
          cid: ulid(),
          bucket: "buk",
          key: "k",
        },
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
    const res = await POST(
      presignReq(
        { op: "put", cid, bucket: "buk", key: "k" },
        // Mismatched token — seeded csrfToken is different.
        generateCsrfToken(),
      ),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
  });
});
