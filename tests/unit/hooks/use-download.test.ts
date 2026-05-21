// tests/unit/hooks/use-download.test.ts
//
// Spec for the helpers underneath `useDownloadObject`. Same approach as
// use-objects.test.ts / use-buckets.test.ts: we don't render the hook in
// vitest's node env — we pin
//
//   * the wire shape of POST /api/r2/presign (op="get", ttl, CSRF header),
//   * the DOM steps of `triggerNativeDownload` (anchor created, clicked,
//     removed),
//   * `deriveDownloadFilename`'s rules for keys with slashes / trailing
//     slashes / dots,
//   * the published TTL constant (900s) — pinned because a change here is a
//     security trade-off (longer URL lifetime = bigger blast radius if leaked).
//
// What this file deliberately does NOT do:
//   * No React rendering of `useDownloadObject` itself — testing the
//     composed mutation under QueryClientProvider needs jsdom + react-dom,
//     neither of which the project's vitest config wires up. The two
//     extracted pure functions cover the same behaviour (URL request +
//     DOM trigger) without that overhead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveDownloadFilename,
  DOWNLOAD_PRESIGN_TTL_SECONDS,
  requestPresignedDownloadUrl,
  triggerNativeDownload,
} from "@/hooks/use-download";
import { ApiClientError } from "@/lib/api/client";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "@/lib/auth/csrf-constants";

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

const SAMPLE_PRESIGN = {
  url: "https://acct.r2.cloudflarestorage.com/buk/key?X-Amz-Signature=abc",
  expiresAt: 1_716_000_900_000,
};

beforeEach(() => {
  // apiFetch reads `csrf` cookie for mutations; stub it so the lazy
  // bootstrap path (`ensureCsrfToken`) never fires and the test doesn't
  // need a second mocked fetch round-trip.
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE_NAME}=tok` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deriveDownloadFilename", () => {
  it("returns the trailing segment for a plain key", () => {
    expect(deriveDownloadFilename("server.log")).toBe("server.log");
  });

  it("returns the last segment for a nested key", () => {
    // Most common case — folder-style listing flattened into one key.
    expect(deriveDownloadFilename("logs/2026/05/server.log")).toBe(
      "server.log",
    );
  });

  it("strips trailing slashes before extracting the last segment", () => {
    // Defensive — the object table never lets the user click a "folder"
    // row's Download button, but mistaking the key for a folder shouldn't
    // produce a blank filename.
    expect(deriveDownloadFilename("logs/2026/")).toBe("2026");
  });

  it("falls back to the original key when there are no separators", () => {
    expect(deriveDownloadFilename("noslashes")).toBe("noslashes");
  });

  it("preserves dots / extensions in the chosen segment", () => {
    expect(deriveDownloadFilename("a.b/c.d.txt")).toBe("c.d.txt");
  });

  it("handles a key that is just '/' without throwing", () => {
    // Pure defensive — listObjects never returns this — but the helper
    // shouldn't blow up on a degenerate input.
    expect(deriveDownloadFilename("/")).toBe("/");
  });
});

describe("DOWNLOAD_PRESIGN_TTL_SECONDS", () => {
  it("is 900s — pinned because changing it shifts the leak window", () => {
    // The audit log doesn't record the TTL, so source is the only place
    // this story is told; locking it into a test makes accidental drift
    // visible in CI.
    expect(DOWNLOAD_PRESIGN_TTL_SECONDS).toBe(900);
  });
});

describe("requestPresignedDownloadUrl", () => {
  it("POSTs to /api/r2/presign with op=get, the 15-min default TTL, and stamped CSRF header", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SAMPLE_PRESIGN));
    const result = await requestPresignedDownloadUrl({
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      key: "logs/2026/server.log",
    });

    expect(result).toEqual(SAMPLE_PRESIGN);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/r2/presign");
    expect(init?.method).toBe("POST");

    // apiFetch routes object bodies through `json` → JSON.stringify, so
    // the body on the wire is a JSON string with all four discriminated
    // fields plus the explicit TTL.
    expect(JSON.parse(init?.body as string)).toEqual({
      op: "get",
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      key: "logs/2026/server.log",
      ttl: 900,
    });

    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    // CSRF stamping happens automatically because this is a mutation; pin
    // the actual token value so a future change to apiFetch can't silently
    // skip the header.
    expect(headers.get(CSRF_HEADER_NAME)).toBe("tok");
  });

  it("propagates ApiClientError on JSON error responses", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            message: "Too many requests",
            requestId: "req-1",
            details: { policy: "presign:user:01HZX0X0X0X0X0X0X0X0X0X0X0" },
          },
        },
        429,
      ),
    );
    try {
      await requestPresignedDownloadUrl({
        cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
        bucket: "primary",
        key: "a.txt",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.status).toBe(429);
      expect(apiErr.code).toBe("rate_limited");
      expect(apiErr.requestId).toBe("req-1");
    }
  });

  it("surfaces R2 credential rejection so the UI can hint at re-adding the connection", async () => {
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
      await requestPresignedDownloadUrl({
        cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
        bucket: "primary",
        key: "a.txt",
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

describe("triggerNativeDownload", () => {
  // Build a thin stub of `document` that records the anchor's mutated
  // properties + DOM lifecycle so we can assert the exact sequence:
  //   createElement('a') → href/download set → appended → clicked → removed.
  //
  // Using a record-everything stub (rather than jsdom) keeps the test
  // node-runnable and avoids pulling jsdom into the vitest deps; the
  // production hook only touches the four DOM methods stubbed here.
  function stubDocument() {
    const anchor: {
      href: string;
      download: string;
      rel: string;
      style: { display: string };
      remove: ReturnType<typeof vi.fn>;
      click: ReturnType<typeof vi.fn>;
    } = {
      href: "",
      download: "",
      rel: "",
      style: { display: "" },
      remove: vi.fn(),
      click: vi.fn(),
    };
    const order: string[] = [];
    anchor.click.mockImplementation(() => {
      order.push("click");
    });
    anchor.remove.mockImplementation(() => {
      order.push("remove");
    });
    const docStub = {
      cookie: `${CSRF_COOKIE_NAME}=tok`,
      createElement: vi.fn((tag: string) => {
        expect(tag).toBe("a");
        order.push("createElement");
        return anchor;
      }),
      body: {
        appendChild: vi.fn((el: unknown) => {
          expect(el).toBe(anchor);
          order.push("appendChild");
          return el;
        }),
      },
    };
    vi.stubGlobal("document", docStub);
    return { anchor, order, docStub };
  }

  it("creates an anchor, applies href/download/rel/style, then clicks and removes it (in order)", () => {
    const { anchor, order } = stubDocument();
    triggerNativeDownload(
      "https://acct.r2.cloudflarestorage.com/buk/a.txt?sig=x",
      "a.txt",
    );

    expect(anchor.href).toBe(
      "https://acct.r2.cloudflarestorage.com/buk/a.txt?sig=x",
    );
    expect(anchor.download).toBe("a.txt");
    // `rel="noopener"` isolates window.opener for the third-party R2 host.
    expect(anchor.rel).toBe("noopener");
    // `display:none` keeps the transient anchor out of the focus order.
    expect(anchor.style.display).toBe("none");
    // The lifecycle MUST be: create → append → click → remove. Any other
    // order risks the click firing on a detached node (no download) or
    // leaving a dangling anchor in the DOM.
    expect(order).toEqual(["createElement", "appendChild", "click", "remove"]);
  });

  it("uses whatever filename the caller passes — derivation happens at the hook layer", () => {
    const { anchor } = stubDocument();
    triggerNativeDownload("https://x/y", "renamed.bin");
    expect(anchor.download).toBe("renamed.bin");
  });

  it("is a safe no-op when `document` is undefined (SSR pass)", () => {
    // Simulate the server-side render path: no DOM at all. The hook only
    // fires in response to a click, so this branch is unreachable in
    // practice — pinning it ensures we never break SSR by throwing.
    vi.stubGlobal("document", undefined);
    expect(() =>
      triggerNativeDownload("https://x/y", "a.txt"),
    ).not.toThrow();
  });
});
