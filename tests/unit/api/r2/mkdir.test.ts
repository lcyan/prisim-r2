import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/audit/log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/r2/route-helpers", () => ({
  resolveConnectionForR2: vi.fn(),
  touchConnectionLastUsed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/r2/control", () => ({
  putEmptyObject: vi.fn(),
}));

// The route reads `getCloudflareContext().env` to forward bindings into
// resolveConnectionForR2. The helper itself is mocked below, so a minimal
// env stub is enough — nothing actually reads off the returned object.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: {} }),
}));

import { POST } from "@/app/api/r2/mkdir/route";
import { resolveConnectionForR2 } from "@/lib/r2/route-helpers";
import { putEmptyObject } from "@/lib/r2/control";
import { R2CredentialError } from "@/lib/r2/errors";
import { logAudit } from "@/lib/audit/log";

const VALID_CID = "01H6Z0K5XJX3J6X9F6X8MZBKVQ";

// The mocked `withApi` rewrites the route's exported `POST` into a
// `(req, ctx) => Promise<Response>` two-arg function. The real Next.js
// signature is single-arg, so we cast through `unknown` once here to keep
// every callsite below typed without sprinkling `as any` everywhere.
const postRoute = POST as unknown as (
  req: Request,
  ctx: { userId: string; requestId: string },
) => Promise<Response>;

function makePostRequest(body: unknown): Request {
  return new Request("http://localhost/api/r2/mkdir", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "fake",
      cookie: "authjs.session-token=fake",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveConnectionForR2 as ReturnType<typeof vi.fn>).mockResolvedValue({
    db: {},
    connection: { id: VALID_CID },
    client: {},
  });
});

// Test-only harness that bypasses the auth/CSRF wrapper. We exercise the
// inner handler logic by stubbing requireSession / requireCsrf to no-ops.
// The TDD focus here is the body of the route — auth / CSRF are tested
// in middleware.test.ts.
//
// The mock still routes through toErrorResponse so thrown ApiErrors land
// as proper Response objects with status + JSON body the test can read.
vi.mock("@/lib/api/middleware", async (orig) => {
  const actual = await (orig as () => Promise<typeof import("@/lib/api/middleware")>)();
  const { toErrorResponse } = await import("@/lib/api/errors");
  return {
    ...actual,
    withApi:
      (handler: (req: Request, ctx: unknown) => Promise<unknown>) =>
      async (req: Request, ctx: unknown) => {
        try {
          const result = await handler(req, ctx);
          if (result instanceof Response) return result;
          return Response.json(result ?? null, { status: 200 });
        } catch (err) {
          return toErrorResponse(err, "test-req-id");
        }
      },
  };
});

describe("POST /api/r2/mkdir", () => {
  it("creates a new folder at root", async () => {
    (putEmptyObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      alreadyExisted: false,
    });
    const req = makePostRequest({
      cid: VALID_CID,
      bucket: "my-bucket",
      parentPrefix: "",
      name: "logs",
    });
    const res = await postRoute(req, {
      userId: "user1",
      requestId: "req1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ key: "logs/", alreadyExisted: false });
    expect(putEmptyObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "my-bucket", key: "logs/" }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "r2.mkdir",
        status: "success",
        key: "logs/",
      }),
      undefined,
    );
  });

  it("creates a nested folder under existing prefix", async () => {
    (putEmptyObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      alreadyExisted: false,
    });
    const req = makePostRequest({
      cid: VALID_CID,
      bucket: "my-bucket",
      parentPrefix: "logs/",
      name: "2025",
    });
    const res = await postRoute(req, {
      userId: "user1",
      requestId: "req1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe("logs/2025/");
  });

  it("returns alreadyExisted=true when HeadObject 200", async () => {
    (putEmptyObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      alreadyExisted: true,
    });
    const req = makePostRequest({
      cid: VALID_CID,
      bucket: "my-bucket",
      parentPrefix: "",
      name: "logs",
    });
    const res = await postRoute(req, {
      userId: "user1",
      requestId: "req1",
    });
    const body = (await res.json()) as { alreadyExisted: boolean };
    expect(body.alreadyExisted).toBe(true);
  });

  it("rejects '.' as folder name with r2.folder_invalid_name", async () => {
    const req = makePostRequest({
      cid: VALID_CID,
      bucket: "my-bucket",
      parentPrefix: "",
      name: ".",
    });
    const res = await postRoute(req, {
      userId: "user1",
      requestId: "req1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("r2.folder_invalid_name");
    expect(putEmptyObject).not.toHaveBeenCalled();
  });

  it("rejects when final key exceeds 1024 bytes with r2.folder_too_deep", async () => {
    // parent (513) + "/" (1) + segment (508) + "/" (1) = 1023 bytes;
    // plus name "z" (1) + trailing "/" (1) → 1025 final-key bytes,
    // which crosses the route's > 1024 cap. Schema's parentPrefix.max(1024)
    // still admits the 1023-byte parent, so the rejection comes from the
    // route's own length check, not Zod.
    const longParent = `${"x".repeat(513)}/${"y".repeat(508)}/`;
    const req = makePostRequest({
      cid: VALID_CID,
      bucket: "my-bucket",
      parentPrefix: longParent,
      name: "z",
    });
    const res = await postRoute(req, {
      userId: "user1",
      requestId: "req1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("r2.folder_too_deep");
  });

  it("maps R2CredentialError to 401 auth.unauthorized + failure audit", async () => {
    (putEmptyObject as ReturnType<typeof vi.fn>).mockRejectedValue(
      new R2CredentialError("creds rejected"),
    );
    const req = makePostRequest({
      cid: VALID_CID,
      bucket: "my-bucket",
      parentPrefix: "",
      name: "logs",
    });
    const res = await postRoute(req, {
      userId: "user1",
      requestId: "req1",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.unauthorized");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "r2.mkdir",
        status: "failure",
      }),
      undefined,
    );
  });
});
