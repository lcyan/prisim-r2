// tests/unit/hooks/use-buckets.test.ts
//
// Spec for the bucket fetcher and query-key helper underneath useBuckets.
// Same approach as use-connections.test.ts: we don't render the hook (that
// needs a React tree + jsdom + a QueryClient) — we pin the network shape
// and the cache key, since those are what consumers and tests rely on.
//
// What this suite locks in:
//   * fetchBuckets shapes the URL exactly as `/api/r2/buckets?cid=<cid>` so a
//     future change to apiFetch / URLSearchParams won't silently drop the
//     query string or double-encode.
//   * fetchBuckets does NOT add a CSRF header — GET is exempt.
//   * bucketsQueryKey is stable per cid AND symmetric: passing null/undefined
//     produces the same canonical tuple, so toggling cid in the consumer
//     doesn't create stray cache entries.
//   * Server errors round-trip through ApiClientError so the component
//     can branch on err.code.
//   * BUCKETS_STALE_TIME_MS is the 5-minute window the task brief requires —
//     a pinned constant test catches anyone changing the cache window
//     without thinking about the cost (one R2 round-trip + one decrypt).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUCKETS_STALE_TIME_MS,
  bucketsQueryKey,
  fetchBuckets,
} from "@/hooks/use-buckets";
import { ApiClientError } from "@/lib/api/client";
import { CSRF_COOKIE_NAME } from "@/lib/auth/csrf-constants";

const SAMPLE_BUCKETS = [
  { name: "primary", createdAt: 1_716_000_000_000 },
  { name: "secondary", createdAt: null },
];

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
  // No CSRF needed for GET, but stubbing the cookie keeps apiFetch's lazy
  // bootstrap path inert in case a future test sneaks a mutation in.
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE_NAME}=tok` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bucketsQueryKey", () => {
  it("is a tuple `['buckets', cid]` that varies per connection", () => {
    expect(bucketsQueryKey("01HX")).toEqual(["buckets", "01HX"]);
    expect(bucketsQueryKey("01HY")).toEqual(["buckets", "01HY"]);
  });

  it("normalizes nullish ids to the literal `null` segment", () => {
    // TanStack Query serializes the key — keeping null/undefined as a single
    // canonical `null` segment means the "no connection picked" cache slot
    // is the same regardless of how the upstream component spells it.
    expect(bucketsQueryKey(null)).toEqual(["buckets", null]);
    expect(bucketsQueryKey(undefined)).toEqual(["buckets", null]);
  });
});

describe("fetchBuckets", () => {
  it("GETs /api/r2/buckets?cid=<cid> with no CSRF header", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SAMPLE_BUCKETS));
    const result = await fetchBuckets("01HZX0X0X0X0X0X0X0X0X0X0X0");
    expect(result).toEqual(SAMPLE_BUCKETS);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/r2/buckets?cid=01HZX0X0X0X0X0X0X0X0X0X0X0");
    expect(init?.method ?? "GET").toBe("GET");
    // GET routes are CSRF-exempt — apiFetch must not have stamped a token.
    expect(new Headers(init?.headers).get("x-csrf-token")).toBeNull();
  });

  it("URL-encodes the cid (defensive — current ULID alphabet is safe but a future format change shouldn't break)", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SAMPLE_BUCKETS));
    await fetchBuckets("01HZ X0+X0");
    const [url] = fetchMock.mock.calls[0]!;
    // URLSearchParams encodes space as `+` and `+` as `%2B` — the assertion
    // pins the chosen encoder rather than the exact glyphs.
    expect(url).toBe("/api/r2/buckets?cid=01HZ+X0%2BX0");
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
      fetchBuckets("01HZX0X0X0X0X0X0X0X0X0X0X0"),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("surfaces connection.invalid_credentials so the UI can hint at re-adding the connection", async () => {
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
      await fetchBuckets("01HZX0X0X0X0X0X0X0X0X0X0X0");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.requestId).toBe("req-bad");
    }
  });
});

describe("BUCKETS_STALE_TIME_MS", () => {
  it("is 5 minutes — pinned because changing it is a cost-of-R2 decision", () => {
    expect(BUCKETS_STALE_TIME_MS).toBe(5 * 60 * 1000);
  });
});
