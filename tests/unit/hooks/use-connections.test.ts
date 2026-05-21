// tests/unit/hooks/use-connections.test.ts
//
// Spec for the network fetchers underneath the connection hooks. We don't
// render the hooks here — exercising useQuery / useMutation requires a
// React tree (and jsdom for the queryFn → setState path), which is more
// machinery than this CRUD wrapper deserves.
//
// Instead, we lock in:
//   * the query-key tuple consumers depend on for invalidation
//   * the endpoint + method + payload each fetcher constructs
//   * that errors from apiFetch propagate unchanged (so hook consumers
//     can catch on err.code instead of err.message)
//
// fetch + document are stubbed exactly as in client.test.ts — same
// approach, same caveats.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTIONS_QUERY_KEY,
  createConnection,
  deleteConnection,
  fetchConnections,
  updateConnection,
} from "@/hooks/use-connections";
import { ApiClientError } from "@/lib/api/client";
import { CSRF_COOKIE_NAME } from "@/lib/auth/csrf-constants";

const SAMPLE_SUMMARY = {
  id: "01HZX0X0X0X0X0X0X0X0X0X0X0",
  name: "personal",
  accountId: "8b21a3f4c705e6d09b8214f6c7a9b3d2",
  accessKeyMasked: "AKIA****WXYZ",
  createdAt: 1_716_286_400_000,
  lastUsedAt: null,
};

function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    responder(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // CSRF cookie present so the apiFetch wrapper doesn't make a bootstrap
  // GET to /api/csrf before each POST/PATCH/DELETE — keeps the assertions
  // focused on the single mutation call.
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE_NAME}=tok` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CONNECTIONS_QUERY_KEY", () => {
  it("is the single-element tuple ['connections']", () => {
    // The literal shape matters — consumers (the page, future sidebar)
    // call invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY }) and
    // setQueryData with this exact tuple. If we ever broaden the key
    // (e.g. ['connections', { scope }]), every call site has to follow.
    expect(CONNECTIONS_QUERY_KEY).toEqual(["connections"]);
    // readonly tuple at the type level — runtime is still an array, but
    // the contract is to treat it as opaque. Asserting length + element
    // pins the shape without depending on Object.freeze at runtime.
    expect(CONNECTIONS_QUERY_KEY).toHaveLength(1);
  });
});

describe("fetchConnections", () => {
  it("GETs /api/connections without a CSRF header", async () => {
    const fetchMock = stubFetch(() => jsonResponse([SAMPLE_SUMMARY]));
    const result = await fetchConnections();
    expect(result).toEqual([SAMPLE_SUMMARY]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/connections");
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get("x-csrf-token")).toBeNull();
  });

  it("propagates ApiClientError on JSON error responses", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "auth.unauthorized",
            message: "not signed in",
            requestId: "req-1",
          },
        },
        401,
      ),
    );
    await expect(fetchConnections()).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("createConnection", () => {
  it("POSTs the full input to /api/connections", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SAMPLE_SUMMARY, 201));
    const result = await createConnection({
      name: "personal",
      accountId: "8b21a3f4c705e6d09b8214f6c7a9b3d2",
      accessKeyId: "AKIA-TEST-ACCESS-KEY-12345",
      secretAccessKey: "0".repeat(40),
    });
    expect(result).toEqual(SAMPLE_SUMMARY);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/connections");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      name: "personal",
      accountId: "8b21a3f4c705e6d09b8214f6c7a9b3d2",
      accessKeyId: "AKIA-TEST-ACCESS-KEY-12345",
    });
    // Secret should be passed through to the server verbatim (server is
    // the one that encrypts) — but we still verify the field is on the
    // wire so a future refactor that masks-before-POST gets caught.
    expect(body.secretAccessKey).toBe("0".repeat(40));
  });

  it("surfaces connection.invalid_credentials as ApiClientError", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "connection.invalid_credentials",
            message: "R2 credentials were rejected by Cloudflare",
            requestId: "req-bad-creds",
          },
        },
        400,
      ),
    );
    try {
      await createConnection({
        name: "x",
        accountId: "a".repeat(32),
        accessKeyId: "x".repeat(20),
        secretAccessKey: "y".repeat(40),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("connection.invalid_credentials");
      expect(apiErr.requestId).toBe("req-bad-creds");
    }
  });
});

describe("updateConnection", () => {
  it("PATCHes /api/connections/[id] with body { name }", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ ...SAMPLE_SUMMARY, name: "renamed" }),
    );
    const result = await updateConnection({
      id: SAMPLE_SUMMARY.id,
      name: "renamed",
    });
    expect(result.name).toBe("renamed");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/connections/${SAMPLE_SUMMARY.id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "renamed" });
  });
});

describe("deleteConnection", () => {
  it("DELETEs /api/connections/[id] and returns the { ok, id } envelope", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ ok: true, id: SAMPLE_SUMMARY.id }),
    );
    const result = await deleteConnection(SAMPLE_SUMMARY.id);
    expect(result).toEqual({ ok: true, id: SAMPLE_SUMMARY.id });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/connections/${SAMPLE_SUMMARY.id}`);
    expect(init?.method).toBe("DELETE");
  });

  it("surfaces connection.in_use as ApiClientError with details", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "connection.in_use",
            message: "Connection has active shares; remove them first",
            requestId: "req-in-use",
            details: { activeShares: 3 },
          },
        },
        409,
      ),
    );
    try {
      await deleteConnection("01HZX0X0X0X0X0X0X0X0X0X0X0");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.code).toBe("connection.in_use");
      expect(apiErr.details).toEqual({ activeShares: 3 });
    }
  });
});
