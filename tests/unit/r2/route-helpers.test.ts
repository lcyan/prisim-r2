// tests/unit/r2/route-helpers.test.ts
//
// Spec for the helpers in lib/r2/route-helpers.ts that don't need a real
// D1 + AES-GCM stack — runR2WithAudit and touchConnectionLastUsed. The
// security-critical paths in resolveConnectionForR2 (user-scoping, AAD
// binding, decrypt-failure audit) are covered end-to-end by every
// app/api/r2/*-route.test.ts that the helper now backs.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("getCloudflareContext should not be called in helper tests");
  },
}));

import { ApiErrorCode } from "@/lib/api/errors";
import { R2CredentialError } from "@/lib/r2/errors";
import { runR2WithAudit, touchConnectionLastUsed } from "@/lib/r2/route-helpers";
import * as auditLog from "@/lib/audit/log";
import type { Db } from "@/lib/db/client";

const logAuditSpy = vi.spyOn(auditLog, "logAudit");

const baseAudit = {
  userId: "u_01",
  connectionId: "c_01",
  op: "upload.create" as const,
  bucket: "my-bucket",
  key: "f.bin",
  req: new Request("https://x/"),
  failureLabel: "createMultipartUpload failed",
};

beforeEach(() => {
  logAuditSpy.mockReset();
  logAuditSpy.mockResolvedValue();
});

describe("runR2WithAudit", () => {
  it("on success: returns the value and writes ONE success audit row", async () => {
    const result = await runR2WithAudit(async () => "ok", baseAudit);
    expect(result).toBe("ok");
    expect(logAuditSpy).toHaveBeenCalledTimes(1);
    expect(logAuditSpy.mock.calls[0]?.[0]).toMatchObject({
      op: "upload.create",
      status: "success",
      bucket: "my-bucket",
      key: "f.bin",
    });
  });

  it("on failure: writes a failure audit row BEFORE rethrowing", async () => {
    const order: string[] = [];
    logAuditSpy.mockImplementation(async () => {
      order.push("audit");
    });

    await expect(
      runR2WithAudit(async () => {
        order.push("fn-throws");
        const err = new Error("kaboom");
        err.name = "S3UpstreamError";
        throw err;
      }, baseAudit),
    ).rejects.toThrow("kaboom");

    expect(order).toEqual(["fn-throws", "audit"]);
    expect(logAuditSpy).toHaveBeenCalledTimes(1);
    expect(logAuditSpy.mock.calls[0]?.[0]).toMatchObject({
      status: "failure",
      errorMsg: "S3UpstreamError",
    });
  });

  it("on R2CredentialError: writes failure audit, then throws ApiErrors.unauthorized", async () => {
    await expect(
      runR2WithAudit(async () => {
        throw new R2CredentialError("creds rejected");
      }, baseAudit),
    ).rejects.toMatchObject({ code: ApiErrorCode.AuthUnauthorized });

    expect(logAuditSpy).toHaveBeenCalledTimes(1);
    expect(logAuditSpy.mock.calls[0]?.[0]).toMatchObject({
      status: "failure",
      errorMsg: "R2CredentialError",
    });
  });

  it("uses failureLabel when the thrown value isn't an Error", async () => {
    await expect(
      runR2WithAudit(async () => {
        throw "plain-string-throw";
      }, baseAudit),
    ).rejects.toBe("plain-string-throw");

    expect(logAuditSpy.mock.calls[0]?.[0]).toMatchObject({
      status: "failure",
      errorMsg: "createMultipartUpload failed",
    });
  });

  it("coerces optional bucket/key to null when omitted", async () => {
    await runR2WithAudit(async () => "ok", {
      userId: "u_01",
      connectionId: "c_01",
      op: "security.decrypt_failed",
      req: new Request("https://x/"),
      failureLabel: "n/a",
    });
    expect(logAuditSpy.mock.calls[0]?.[0]).toMatchObject({
      bucket: null,
      key: null,
    });
  });
});

describe("touchConnectionLastUsed", () => {
  function makeDb(opts: { throwOn?: boolean } = {}): {
    db: Db;
    captured: { setArg?: unknown };
  } {
    const captured: { setArg?: unknown } = {};
    const stub = {
      update() {
        return {
          set(arg: unknown) {
            captured.setArg = arg;
            return {
              where() {
                return {
                  run() {
                    if (opts.throwOn) {
                      return Promise.reject(new Error("D1 write timeout"));
                    }
                    return Promise.resolve({ success: true });
                  },
                };
              },
            };
          },
        };
      },
    };
    return { db: stub as unknown as Db, captured };
  }

  it("issues the UPDATE on the happy path", async () => {
    const { db, captured } = makeDb();
    await touchConnectionLastUsed(db, {
      connectionId: "c_01",
      userId: "u_01",
      requestId: "req_01",
      tag: "buckets",
    });
    expect(captured.setArg).toHaveProperty("lastUsedAt");
  });

  it("never throws when the UPDATE fails — telemetry-only", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb({ throwOn: true });
    await expect(
      touchConnectionLastUsed(db, {
        connectionId: "c_01",
        userId: "u_01",
        requestId: "req_01",
        tag: "list",
      }),
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[list req_01] last_used_at update failed for cid=c_01"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
