// tests/unit/api/client.test.ts
//
// Spec for the browser-side fetch wrapper. We stub `document` and `fetch`
// at the global level so the tests run in plain Node (matches the rest of
// the suite — no jsdom dependency).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  ApiClientError,
  readCookie,
  readCsrfCookie,
  ensureCsrfToken,
} from "@/lib/api/client";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@/lib/auth/csrf";

// Stand in for `window.document` — we only need the `cookie` property. Going
// through `vi.stubGlobal` keeps the cast to Document at one place instead of
// fighting the lib.dom Document type in every test.
function setDocumentCookie(value: string): void {
  vi.stubGlobal("document", { cookie: value });
}

beforeEach(() => {
  setDocumentCookie("");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readCookie", () => {
  it("parses a single cookie", () => {
    setDocumentCookie("csrf=abc123");
    expect(readCookie("csrf")).toBe("abc123");
    expect(readCsrfCookie()).toBe("abc123");
  });

  it("parses one cookie out of many, ignoring whitespace", () => {
    setDocumentCookie("foo=1; csrf=token-xyz ; bar=baz");
    expect(readCookie("csrf")).toBe("token-xyz");
  });

  it("returns null when absent", () => {
    setDocumentCookie("foo=1");
    expect(readCookie("csrf")).toBeNull();
  });

  it("preserves '=' inside the value", () => {
    setDocumentCookie("csrf=YWJjPT0");
    expect(readCookie("csrf")).toBe("YWJjPT0");
  });
});

describe("apiFetch", () => {
  it("attaches X-CSRF-Token on POST when cookie is present", async () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=hdr-token`);
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/test", { method: "POST", json: { a: 1 } });
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBe("hdr-token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("does NOT attach X-CSRF-Token on GET", async () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=should-not-be-sent`);
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/test");
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBeNull();
  });

  it("bootstraps CSRF token via /api/csrf when cookie is missing", async () => {
    // No cookie → ensureCsrfToken triggers a GET /api/csrf, which the
    // server-side route would normally set via Set-Cookie. The fetch mock
    // returns the JSON-only response and we verify the bootstrap call.
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url === "/api/csrf") {
        return new Response(JSON.stringify({ csrfToken: "fresh-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/connections", { method: "POST", json: {} });

    expect(calls[0]?.[0]).toBe("/api/csrf");
    const mutateInit = calls[1]?.[1] as RequestInit;
    const headers = new Headers(mutateInit.headers);
    expect(headers.get(CSRF_HEADER_NAME)).toBe("fresh-token");
  });

  it("throws ApiClientError with code+message+requestId on JSON error response", async () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=t`);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "csrf.invalid",
            message: "Invalid CSRF token",
            requestId: "req-1",
          },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json", "x-request-id": "req-1" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/test", { method: "POST", json: {} })).rejects.toMatchObject({
      name: "ApiClientError",
      code: "csrf.invalid",
      requestId: "req-1",
      status: 401,
    });
  });

  it("returns undefined for 204 responses", async () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=t`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await apiFetch("/api/test", { method: "DELETE" })).toBeUndefined();
  });
});

describe("ensureCsrfToken", () => {
  it("returns the existing cookie value without hitting the server", async () => {
    setDocumentCookie(`${CSRF_COOKIE_NAME}=already-here`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await ensureCsrfToken()).toBe("already-here");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ApiClientError shape", () => {
  it("preserves all fields", () => {
    const e = new ApiClientError("auth.unauthorized", "no", 401, "req-x", { y: 1 });
    expect({ code: e.code, message: e.message, status: e.status, requestId: e.requestId, details: e.details }).toEqual({
      code: "auth.unauthorized",
      message: "no",
      status: 401,
      requestId: "req-x",
      details: { y: 1 },
    });
  });
});
