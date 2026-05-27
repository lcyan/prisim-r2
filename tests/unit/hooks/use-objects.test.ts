// tests/unit/hooks/use-objects.test.ts
//
// Spec for the bare `fetchObjects` function and the `objectsQueryKey` helper
// underneath `useObjects`. Same approach as use-buckets.test.ts: we don't
// render the hook (vitest node env) — we pin the wire shape so the API
// contract between hook and route can't drift silently.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchObjects,
  objectsQueryKey,
  OBJECTS_STALE_TIME_MS,
} from "@/hooks/use-objects";
import { ApiClientError } from "@/lib/api/client";
import { CSRF_COOKIE_NAME } from "@/lib/auth/csrf-constants";

const EMPTY_PAGE = { objects: [], prefixes: [], nextCursor: null };

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
  // GET is CSRF-exempt but stub a cookie so apiFetch's bootstrap path
  // stays inert if a future test sneaks a mutation in.
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE_NAME}=tok` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("objectsQueryKey", () => {
  it("is a 4-tuple ['objects', cid, bucket, prefix]", () => {
    expect(
      objectsQueryKey("01HZX0X0X0X0X0X0X0X0X0X0X0", "primary", "a/b/"),
    ).toEqual(["objects", "01HZX0X0X0X0X0X0X0X0X0X0X0", "primary", "a/b/"]);
  });

  it("normalizes nullish ids/buckets to canonical null", () => {
    // Without canonicalization a hook that spelled "no value" as undefined
    // and another spelling it as null would create two separate cache
    // entries for the same logical state.
    expect(objectsQueryKey(null, null, "")).toEqual([
      "objects",
      null,
      null,
      "",
    ]);
    expect(objectsQueryKey(undefined, undefined, undefined)).toEqual([
      "objects",
      null,
      null,
      "",
    ]);
  });

  it("treats prefix '' and prefix 'a/' as distinct cache slots", () => {
    expect(objectsQueryKey("c", "b", "")).not.toEqual(
      objectsQueryKey("c", "b", "a/"),
    );
  });
});

describe("fetchObjects", () => {
  it("builds /api/r2/list?cid=…&bucket=…&prefix=… (no cursor for the first page)", async () => {
    const fetchMock = stubFetch(() => jsonResponse(EMPTY_PAGE));
    await fetchObjects({
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      prefix: "",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "/api/r2/list?cid=01HZX0X0X0X0X0X0X0X0X0X0X0&bucket=primary&prefix=",
    );
    expect(init?.method ?? "GET").toBe("GET");
    // GET routes are CSRF-exempt.
    expect(new Headers(init?.headers).get("x-csrf-token")).toBeNull();
  });

  it("appends &cursor=<opaque> when a continuation token is supplied", async () => {
    const fetchMock = stubFetch(() => jsonResponse(EMPTY_PAGE));
    await fetchObjects({
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      prefix: "a/b/",
      cursor: "opaque-cursor-token",
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "/api/r2/list?cid=01HZX0X0X0X0X0X0X0X0X0X0X0&bucket=primary&prefix=a%2Fb%2F&cursor=opaque-cursor-token",
    );
  });

  it("URL-encodes prefix segments that contain reserved characters", async () => {
    const fetchMock = stubFetch(() => jsonResponse(EMPTY_PAGE));
    await fetchObjects({
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      // R2 keys legitimately may contain spaces and '+'.
      prefix: "my folder/sub+a/",
    });
    const [url] = fetchMock.mock.calls[0]!;
    // URLSearchParams encodes ' ' → '+' and '+' → '%2B', '/' → '%2F'.
    expect(url).toBe(
      "/api/r2/list?cid=01HZX0X0X0X0X0X0X0X0X0X0X0&bucket=primary&prefix=my+folder%2Fsub%2Ba%2F",
    );
  });

  it("returns the parsed R2ListResponse shape on success", async () => {
    const body = {
      objects: [
        {
          key: "a.txt",
          size: 12,
          etag: '"abc"',
          lastModified: 1_716_000_000_000,
        },
      ],
      prefixes: ["sub/"],
      nextCursor: "next-token",
    };
    stubFetch(() => jsonResponse(body));
    const result = await fetchObjects({
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      prefix: "",
    });
    expect(result).toEqual(body);
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
    await expect(
      fetchObjects({
        cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
        bucket: "primary",
        prefix: "",
      }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("surfaces R2 credential rejection so the UI can branch on .code", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "auth.unauthorized",
            message: "R2 credentials rejected",
            requestId: "req-bad",
          },
        },
        401,
      ),
    );
    try {
      await fetchObjects({
        cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
        bucket: "primary",
        prefix: "",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.code).toBe("auth.unauthorized");
    }
  });
});

describe("OBJECTS_STALE_TIME_MS", () => {
  it("is one minute — pinned because the cost is a real R2 list call", () => {
    expect(OBJECTS_STALE_TIME_MS).toBe(60 * 1000);
  });
});
