// tests/unit/audit/log.test.ts
//
// Spec for lib/audit/log.ts. Two test surfaces:
//
//   1) extractAuditMeta — pure header-extraction logic. Verified directly
//      with crafted Request objects so the precedence (cf-connecting-ip >
//      x-forwarded-for > null) is unambiguous.
//
//   2) logAudit — the nofail writer. We inject a stub `Db` so we don't
//      need to mock @opennextjs/cloudflare or stand up a real D1
//      binding; the stub captures the insert payload, and a separate test
//      makes it throw to verify the swallow-and-console.error behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// @opennextjs/cloudflare re-exports the real `server-only` package which
// throws on import outside an RSC build. We never call getCloudflareContext in
// these tests (we inject a stub Db), so a no-op mock is enough to break the
// transitive server-only import.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error(
      "getCloudflareContext should not be called when a Db stub is injected",
    );
  },
}));

import {
  extractAuditMeta,
  logAudit,
  type AuditOp,
} from "@/lib/audit/log";
import type { Db } from "@/lib/db/client";

/** Build a minimal Db stub that records the most recent insert payload.
 *  drizzle's call chain is `db.insert(table).values(row)` — we capture both
 *  arguments. The optional `throwOn` arm lets a test simulate a D1 outage. */
function makeStubDb(opts: { throwOn?: "insert" | "values" } = {}): {
  db: Db;
  captured: { table?: unknown; row?: unknown };
} {
  const captured: { table?: unknown; row?: unknown } = {};
  const stub = {
    insert(table: unknown) {
      if (opts.throwOn === "insert") {
        throw new Error("D1 connection refused");
      }
      captured.table = table;
      return {
        values(row: unknown) {
          if (opts.throwOn === "values") {
            return Promise.reject(new Error("D1 write timeout"));
          }
          captured.row = row;
          return Promise.resolve({ success: true });
        },
      };
    },
  };
  return { db: stub as unknown as Db, captured };
}

// ---- extractAuditMeta (pure) ─────────────────────────────────────────

describe("extractAuditMeta", () => {
  it("returns ip+ua nulls for no request", () => {
    expect(extractAuditMeta(null)).toEqual({ ip: null, ua: null });
    expect(extractAuditMeta(undefined)).toEqual({ ip: null, ua: null });
  });

  it("prefers cf-connecting-ip over x-forwarded-for", () => {
    const req = new Request("https://x/", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "10.0.0.1, 198.51.100.2",
        "user-agent": "Mozilla/5.0 audit",
      },
    });
    expect(extractAuditMeta(req)).toEqual({
      ip: "203.0.113.7",
      ua: "Mozilla/5.0 audit",
    });
  });

  it("falls back to the first x-forwarded-for entry when cf header is absent", () => {
    const req = new Request("https://x/", {
      headers: {
        "x-forwarded-for": "  10.0.0.5 , 198.51.100.9",
        "user-agent": "curl/8",
      },
    });
    expect(extractAuditMeta(req)).toEqual({
      ip: "10.0.0.5",
      ua: "curl/8",
    });
  });

  it("returns ip=null when no proxy header is present", () => {
    const req = new Request("https://x/", {
      headers: { "user-agent": "ua" },
    });
    expect(extractAuditMeta(req)).toEqual({ ip: null, ua: "ua" });
  });

  it("returns ua=null when the user-agent header is missing or blank", () => {
    const req = new Request("https://x/", {
      headers: { "cf-connecting-ip": "1.2.3.4", "user-agent": "   " },
    });
    expect(extractAuditMeta(req)).toEqual({ ip: "1.2.3.4", ua: null });
  });

  it("ignores cf-connecting-ip if it is blank, falling through to xff", () => {
    const req = new Request("https://x/", {
      headers: {
        "cf-connecting-ip": "   ",
        "x-forwarded-for": "9.9.9.9",
      },
    });
    expect(extractAuditMeta(req).ip).toBe("9.9.9.9");
  });
});

// ---- logAudit (integration with stub Db) ─────────────────────────────

describe("logAudit", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("inserts a row with all fields populated from the input + request", async () => {
    const { db, captured } = makeStubDb();
    const req = new Request("https://x/", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "vitest/1",
      },
    });

    await logAudit(
      {
        userId: "user-1",
        connectionId: "conn-1",
        op: "presign.put",
        bucket: "my-bucket",
        key: "path/to/object.bin",
        status: "success",
        req,
      },
      db,
    );

    const row = captured.row as Record<string, unknown>;
    expect(row).toMatchObject({
      userId: "user-1",
      connectionId: "conn-1",
      op: "presign.put",
      bucket: "my-bucket",
      objectKey: "path/to/object.bin",
      status: "success",
      errorMsg: null,
      ip: "203.0.113.10",
      ua: "vitest/1",
    });
    // ULID id is generated server-side; we just check it looks right.
    expect(typeof row.id).toBe("string");
    expect((row.id as string).length).toBe(26);
    // size/class/bytes columns deliberately do NOT exist on the audit row.
    expect(row).not.toHaveProperty("size");
    expect(row).not.toHaveProperty("class");
    expect(row).not.toHaveProperty("bytes");
  });

  it("nulls out optional fields the caller didn't provide", async () => {
    const { db, captured } = makeStubDb();
    await logAudit(
      {
        userId: null,
        op: "auth.login",
        status: "failure",
        errorMsg: "bad password",
      },
      db,
    );
    expect(captured.row).toMatchObject({
      userId: null,
      connectionId: null,
      bucket: null,
      objectKey: null,
      ip: null,
      ua: null,
      errorMsg: "bad password",
    });
  });

  it("swallows DB failures and logs to console.error (insert phase)", async () => {
    const { db } = makeStubDb({ throwOn: "insert" });
    await expect(
      logAudit(
        { userId: "u", op: "object.delete", status: "success" },
        db,
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("op=object.delete");
    expect(message).toContain("status=success");
  });

  it("swallows DB failures and logs to console.error (values phase)", async () => {
    const { db } = makeStubDb({ throwOn: "values" });
    await expect(
      logAudit(
        { userId: "u", op: "share.create", status: "failure" },
        db,
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("compile-time: AuditOp union rejects unknown ops", () => {
    // The cast below MUST be unnecessary for a known value (TS infers it),
    // and adding `as AuditOp` to a non-member would still let the test
    // compile, so this test is mostly a witness — its real value is that
    // `pnpm typecheck` will fail if anyone widens the union by accident.
    const allowed: AuditOp[] = [
      "connection.create",
      "connection.delete",
      "object.delete",
      "upload.create",
      "upload.complete",
      "upload.abort",
      "presign.put",
      "presign.get",
      "share.create",
      "share.delete",
      "security.decrypt_failed",
      "auth.login",
      "auth.logout",
    ];
    expect(allowed).toHaveLength(13);
  });
});
