// tests/unit/api/audit-route.test.ts
//
// Integration spec for GET /api/audit.
//
// Same fat-test pattern as share-routes / r2-delete-routes: real
// D1-shaped SQLite + real drizzle so the WHERE / ORDER BY / cursor logic
// is exercised end-to-end. No external services to stub — audit listing
// hits the DB and nothing else.
//
// What this suite proves:
//   - returns the user's rows newest-first
//   - op filter narrows to a single AuditOp value
//   - bucket filter narrows to one bucket name
//   - cursor pagination is stable across pages (no row duplicated, none
//     lost) for an even multiple of the page size and for an extra
//     same-ms row
//   - malformed cursor → 400 validation.invalid
//   - other users' rows are never visible
//   - unauthenticated → 401

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

import { generateCsrfToken, hashCsrfToken } from "@/lib/auth/csrf";
import { schema as realSchema } from "@/lib/db/schema";
import type { RateLimitDb } from "@/lib/api/rate-limit";
import { ApiErrorCode } from "@/lib/api/errors";
import { AUDIT_LIST_PAGE_SIZE } from "@/lib/api/schemas";

const AUTH_SECRET = "audit-route-test-auth-secret";

type SqliteDb = InstanceType<typeof Database>;
let sqlite: SqliteDb;
let drizzleDb: ReturnType<typeof drizzleSqlite>;
let d1Facade: RateLimitDb;

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };
const fakeSessionStore = new Map<
  string,
  { csrfTokenHash: string | null; userId: string; email: string }
>();

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => fakeJwt.token),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      DB: d1Facade,
      AUTH_SECRET,
    },
  }),
}));

vi.mock("@/lib/db/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
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
import { GET as auditGET } from "@/app/api/audit/route";

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

async function seedUser(opts: { loginAs?: boolean } = {}): Promise<{
  userId: string;
  csrfToken: string;
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

  if (opts.loginAs !== false) {
    fakeSessionStore.set(sessionToken, {
      csrfTokenHash,
      userId,
      email: `${userId}@test.local`,
    });
    fakeJwt.token = { userId, sessionToken, csrfToken };
  }
  return { userId, csrfToken };
}

/**
 * Insert one audit_log row directly so we control createdAt precisely.
 * The DB column is stored as INTEGER (unix seconds via drizzle's
 * timestamp mode); pass the seconds-precision value to keep ordering
 * deterministic across the suite.
 */
function insertAuditRow(args: {
  userId: string;
  op: string;
  bucket?: string | null;
  key?: string | null;
  status?: "success" | "failure";
  ip?: string | null;
  /** Seconds since epoch — controls ordering. */
  createdAtSec: number;
  /** Override the row id (otherwise a fresh ULID is generated). Useful
   *  to pin lexicographic ordering for the (createdAt, id) tie-break tests. */
  id?: string;
}): string {
  const id = args.id ?? ulid();
  sqlite
    .prepare(
      `INSERT INTO audit_log
       (id, user_id, connection_id, op, bucket, object_key,
        status, error_msg, ip, ua, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
    )
    .run(
      id,
      args.userId,
      args.op,
      args.bucket ?? null,
      args.key ?? null,
      args.status ?? "success",
      args.ip ?? null,
      args.createdAtSec,
    );
  return id;
}

function listReq(query?: Record<string, string>): Request {
  const url = new URL("https://x/api/audit");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return new Request(url.toString(), { method: "GET" });
}

async function readJson(res: Response): Promise<{
  items?: Array<{
    id: string;
    op: string;
    status: "success" | "failure";
    bucket: string | null;
    key: string | null;
    connectionId: string | null;
    errorMsg: string | null;
    ip: string | null;
    ua: string | null;
    createdAt: number;
  }>;
  nextCursor?: string | null;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}> {
  return (await res.json()) as Awaited<ReturnType<typeof readJson>>;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  drizzleDb = drizzleSqlite(sqlite, { schema: realSchema });
  d1Facade = makeD1Facade(sqlite);
  fakeJwt.token = null;
  fakeSessionStore.clear();
});

describe("GET /api/audit — auth", () => {
  it("rejects requests without a session (401)", async () => {
    const res = await auditGET(listReq());
    expect(res.status).toBe(401);
  });
});

describe("GET /api/audit — listing", () => {
  it("returns the user's rows newest-first", async () => {
    const { userId } = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "b",
      key: "old.txt",
      createdAtSec: now - 100,
    });
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "b",
      key: "new.txt",
      createdAtSec: now - 10,
    });

    const res = await auditGET(listReq());
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["new.txt", "old.txt"]);
    expect(body.nextCursor).toBeNull();
  });

  it("excludes other users' rows", async () => {
    const userA = await seedUser({ loginAs: false });
    const userB = await seedUser({ loginAs: true });
    const now = Math.floor(Date.now() / 1000);
    insertAuditRow({
      userId: userA.userId,
      op: "object.delete",
      bucket: "b",
      key: "userA.txt",
      createdAtSec: now - 10,
    });
    insertAuditRow({
      userId: userB.userId,
      op: "object.delete",
      bucket: "b",
      key: "userB.txt",
      createdAtSec: now - 5,
    });

    const res = await auditGET(listReq());
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["userB.txt"]);
  });
});

describe("GET /api/audit — filters", () => {
  it("op filter narrows to one AuditOp value", async () => {
    const { userId } = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "b",
      key: "del.txt",
      createdAtSec: now - 30,
    });
    insertAuditRow({
      userId,
      op: "presign.get",
      bucket: "b",
      key: "get.txt",
      createdAtSec: now - 20,
    });
    insertAuditRow({
      userId,
      op: "share.create",
      bucket: "b",
      key: "share.txt",
      createdAtSec: now - 10,
    });

    const res = await auditGET(listReq({ op: "object.delete" }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["del.txt"]);
    expect(body.items?.every((i) => i.op === "object.delete")).toBe(true);
  });

  it("bucket filter narrows to one bucket name (exact match)", async () => {
    const { userId } = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "alpha",
      key: "a.txt",
      createdAtSec: now - 20,
    });
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "beta",
      key: "b.txt",
      createdAtSec: now - 10,
    });

    const res = await auditGET(listReq({ bucket: "alpha" }));
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["a.txt"]);
  });

  it("op + bucket compose (AND)", async () => {
    const { userId } = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "alpha",
      key: "match.txt",
      createdAtSec: now - 30,
    });
    insertAuditRow({
      userId,
      op: "object.delete",
      bucket: "beta",
      key: "wrong-bucket.txt",
      createdAtSec: now - 20,
    });
    insertAuditRow({
      userId,
      op: "presign.get",
      bucket: "alpha",
      key: "wrong-op.txt",
      createdAtSec: now - 10,
    });

    const res = await auditGET(
      listReq({ op: "object.delete", bucket: "alpha" }),
    );
    const body = await readJson(res);
    expect(body.items?.map((i) => i.key)).toEqual(["match.txt"]);
  });

  it("rejects an unknown op (validation.invalid 400)", async () => {
    await seedUser();
    const res = await auditGET(listReq({ op: "not-a-real-op" }));
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.ValidationInvalid);
  });

  it("rejects a malformed bucket (S3 naming rules, 400)", async () => {
    await seedUser();
    // Underscores aren't allowed in S3-style bucket names — the schema
    // rejects them at the boundary so a typo doesn't silently return 0
    // rows.
    const res = await auditGET(listReq({ bucket: "BAD_BUCKET" }));
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.ValidationInvalid);
  });
});

describe("GET /api/audit — pagination", () => {
  it("emits nextCursor only when there are more rows than the page size", async () => {
    const { userId } = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    // Page-size + 2 rows so we get one full page + a short second page.
    const total = AUDIT_LIST_PAGE_SIZE + 2;
    for (let i = 0; i < total; i++) {
      insertAuditRow({
        userId,
        op: "object.delete",
        bucket: "b",
        key: `k${i.toString().padStart(4, "0")}.txt`,
        // Spread across distinct seconds so ordering is deterministic
        // by createdAt alone (no need to rely on id tie-break for this
        // specific test).
        createdAtSec: now - (total * 2 - i),
      });
    }

    const res1 = await auditGET(listReq());
    const body1 = await readJson(res1);
    expect(body1.items).toHaveLength(AUDIT_LIST_PAGE_SIZE);
    expect(body1.nextCursor).toBeTypeOf("string");

    const res2 = await auditGET(listReq({ cursor: body1.nextCursor! }));
    const body2 = await readJson(res2);
    expect(body2.items).toHaveLength(2);
    expect(body2.nextCursor).toBeNull();

    // Combined pages cover every key exactly once.
    const seen = new Set<string>();
    for (const it of [...(body1.items ?? []), ...(body2.items ?? [])]) {
      expect(seen.has(it.key!)).toBe(false);
      seen.add(it.key!);
    }
    expect(seen.size).toBe(total);
  });

  it("rejects a malformed cursor (validation.invalid 400)", async () => {
    await seedUser();
    const res = await auditGET(listReq({ cursor: "not-a-cursor" }));
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.ValidationInvalid);
  });

  it("breaks createdAt ties using id (DESC) — no row duplicated across pages", async () => {
    const { userId } = await seedUser();
    const now = Math.floor(Date.now() / 1000);
    // All rows share the same second. The (createdAt, id) tuple must
    // still order deterministically (id DESC) so the cursor's tie-break
    // branch is exercised.
    const tieSec = now - 5;
    const ids: string[] = [];
    for (let i = 0; i < AUDIT_LIST_PAGE_SIZE + 1; i++) {
      const id = insertAuditRow({
        userId,
        op: "object.delete",
        bucket: "b",
        key: `tie-${i}.txt`,
        createdAtSec: tieSec,
      });
      ids.push(id);
    }
    // Sort to confirm expected lexicographic ordering (DESC).
    ids.sort();
    const idsDesc = [...ids].reverse();

    const res1 = await auditGET(listReq());
    const body1 = await readJson(res1);
    expect(body1.items).toHaveLength(AUDIT_LIST_PAGE_SIZE);
    expect(body1.items?.map((i) => i.id)).toEqual(
      idsDesc.slice(0, AUDIT_LIST_PAGE_SIZE),
    );
    expect(body1.nextCursor).toBeTypeOf("string");

    const res2 = await auditGET(listReq({ cursor: body1.nextCursor! }));
    const body2 = await readJson(res2);
    expect(body2.items).toHaveLength(1);
    expect(body2.items?.[0]?.id).toBe(idsDesc[AUDIT_LIST_PAGE_SIZE]);
    expect(body2.nextCursor).toBeNull();
  });
});
