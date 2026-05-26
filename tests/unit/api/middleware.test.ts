// tests/unit/api/middleware.test.ts
//
// Spec for lib/api/middleware.ts. Two test surfaces:
//
//   1) requireCsrf — pure function (header + session.csrfTokenHash compare).
//      Verified directly with crafted Request + session objects.
//
//   2) withApi — the full pipeline. We mock `next-auth/jwt` and the
//      Cloudflare runtime context so the handler runs in plain Node. The
//      D1 adapter is replaced with an in-memory fixture that mirrors
//      `getSessionAndUser` semantics.
//
// What we explicitly assert:
//   - POST without X-CSRF-Token → 401 + code csrf.invalid
//   - POST with wrong header → 401 + code csrf.invalid
//   - GET bypasses CSRF (read-only)
//   - Missing JWT → 401 + code auth.unauthorized
//   - Revoked session (D1 lookup miss) → 401
//   - ZodError thrown by handler → 400 + code validation.invalid
//   - Unknown throw → 500 + code internal.unexpected (no leak)
//   - Every response includes the x-request-id header AND requestId in body

import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

import {
  CSRF_HEADER_NAME,
  hashCsrfToken,
  generateCsrfToken,
} from "@/lib/auth/csrf";

// ---- mocks ────────────────────────────────────────────────────────────
//
// getToken: we control what the JWT looks like per test.
// getCloudflareContext + adapter: simulate the D1 lookup.

const fakeJwt: { token: Record<string, unknown> | null } = { token: null };

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => fakeJwt.token),
}));

const fakeSessionStore = new Map<string, { csrfTokenHash: string | null; userId: string; email: string }>();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { DB: {}, AUTH_SECRET: "test-secret" } }),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({}),
}));

vi.mock("@/lib/auth/adapter", () => ({
  createD1Adapter: () => ({
    async getSessionAndUser(token: string) {
      const row = fakeSessionStore.get(token);
      if (!row) return null;
      return {
        user: { id: row.userId, email: row.email },
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        csrfTokenHash: row.csrfTokenHash,
      };
    },
  }),
}));

// Imports must come after vi.mock for the mocks to apply.
import { requireCsrf, withApi } from "@/lib/api/middleware";
import { ApiErrorCode } from "@/lib/api/errors";

function seedSession(args: {
  sessionToken: string;
  csrfToken: string;
  userId?: string;
}): Promise<{ csrfTokenHash: string }> {
  return hashCsrfToken(args.csrfToken).then((csrfTokenHash) => {
    fakeSessionStore.set(args.sessionToken, {
      csrfTokenHash,
      userId: args.userId ?? "user-1",
      email: "u@example.com",
    });
    fakeJwt.token = {
      userId: args.userId ?? "user-1",
      sessionToken: args.sessionToken,
      csrfToken: args.csrfToken,
    };
    return { csrfTokenHash };
  });
}

beforeEach(() => {
  fakeSessionStore.clear();
  fakeJwt.token = null;
});

// ---- requireCsrf (pure) ───────────────────────────────────────────────

describe("requireCsrf", () => {
  it("accepts header that hashes to session.csrfTokenHash", async () => {
    const token = generateCsrfToken();
    const csrfTokenHash = await hashCsrfToken(token);
    const req = new Request("https://x/", {
      method: "POST",
      headers: { [CSRF_HEADER_NAME]: token },
    });
    await expect(
      requireCsrf(req, { csrfTokenHash }),
    ).resolves.toBeUndefined();
  });

  it("rejects when header is missing", async () => {
    const req = new Request("https://x/", { method: "POST" });
    await expect(
      requireCsrf(req, { csrfTokenHash: "deadbeef".repeat(8) }),
    ).rejects.toMatchObject({ code: ApiErrorCode.CsrfInvalid });
  });

  it("rejects when header doesn't hash to stored hash", async () => {
    const csrfTokenHash = await hashCsrfToken(generateCsrfToken());
    const req = new Request("https://x/", {
      method: "POST",
      headers: { [CSRF_HEADER_NAME]: generateCsrfToken() },
    });
    await expect(
      requireCsrf(req, { csrfTokenHash }),
    ).rejects.toMatchObject({ code: ApiErrorCode.CsrfInvalid });
  });

  it("rejects when session has no csrf binding (legacy row)", async () => {
    const req = new Request("https://x/", {
      method: "POST",
      headers: { [CSRF_HEADER_NAME]: generateCsrfToken() },
    });
    await expect(
      requireCsrf(req, { csrfTokenHash: null }),
    ).rejects.toMatchObject({ code: ApiErrorCode.CsrfInvalid });
  });
});

// ---- withApi (integration) ────────────────────────────────────────────

async function readJson(res: Response) {
  return (await res.json()) as {
    error?: { code: string; message: string; requestId: string };
  } & Record<string, unknown>;
}

describe("withApi", () => {
  it("rejects POST with no JWT → 401 auth.unauthorized", async () => {
    fakeJwt.token = null;
    const handler = withApi(async () => ({ ok: true }));
    const res = await handler(
      new Request("https://x/", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.AuthUnauthorized);
    expect(body.error?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("x-request-id")).toBe(body.error?.requestId);
  });

  it("rejects POST without X-CSRF-Token → 401 csrf.invalid", async () => {
    await seedSession({ sessionToken: "sess-1", csrfToken: generateCsrfToken() });
    const handler = withApi(async () => ({ ok: true }));
    const res = await handler(new Request("https://x/", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
  });

  it("rejects POST with wrong X-CSRF-Token → 401 csrf.invalid", async () => {
    await seedSession({ sessionToken: "sess-2", csrfToken: generateCsrfToken() });
    const handler = withApi(async () => ({ ok: true }));
    const res = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: "definitely-not-the-token" },
      }),
    );
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.CsrfInvalid);
  });

  it("passes POST with correct X-CSRF-Token and invokes handler", async () => {
    const csrfToken = generateCsrfToken();
    await seedSession({ sessionToken: "sess-3", csrfToken });
    const handler = withApi(async (_req, ctx) => ({
      userId: ctx.userId,
      requestId: ctx.requestId,
    }));
    const res = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.userId).toBe("user-1");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("x-request-id")).toBe(body.requestId as string);
  });

  it("does NOT require CSRF on GET", async () => {
    await seedSession({ sessionToken: "sess-4", csrfToken: generateCsrfToken() });
    const handler = withApi(async () => ({ ok: true }));
    const res = await handler(new Request("https://x/", { method: "GET" }));
    expect(res.status).toBe(200);
  });

  it("rejects when D1 session row is gone (revoked) → 401", async () => {
    // JWT exists but the underlying session row was deleted.
    fakeJwt.token = {
      userId: "user-1",
      sessionToken: "deleted",
      csrfToken: generateCsrfToken(),
    };
    const handler = withApi(async () => ({ ok: true }));
    const res = await handler(new Request("https://x/", { method: "GET" }));
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe(ApiErrorCode.AuthUnauthorized);
  });

  it("maps ZodError thrown in handler to 400 validation.invalid", async () => {
    const csrfToken = generateCsrfToken();
    await seedSession({ sessionToken: "sess-5", csrfToken });
    const handler = withApi(async () => {
      z.object({ x: z.number() }).parse({ x: "no" });
      return { ok: true };
    });
    const res = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.ValidationInvalid);
    expect(body.error?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("collapses unknown throws to 500 internal.unexpected (no message leak)", async () => {
    const csrfToken = generateCsrfToken();
    await seedSession({ sessionToken: "sess-6", csrfToken });
    const handler = withApi(async () => {
      throw new Error("internal sql: SELECT * FROM secrets");
    });
    const res = await handler(
      new Request("https://x/", {
        method: "POST",
        body: "{}",
        headers: { [CSRF_HEADER_NAME]: csrfToken },
      }),
    );
    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.error?.code).toBe(ApiErrorCode.InternalUnexpected);
    expect(body.error?.message).not.toContain("SELECT");
  });

  it("passes a handler-returned Response through and injects x-request-id", async () => {
    await seedSession({ sessionToken: "sess-7", csrfToken: generateCsrfToken() });
    const handler = withApi(async () =>
      new Response("hello", { status: 201, headers: { "x-custom": "1" } }),
    );
    const res = await handler(new Request("https://x/", { method: "GET" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
