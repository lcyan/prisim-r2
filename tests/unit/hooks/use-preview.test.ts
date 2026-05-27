// tests/unit/hooks/use-preview.test.ts
//
// Spec for the helpers underneath `usePresignPreviewUrl` + `fetchTextHead`.
// Same approach as use-download.test.ts: we don't render React, just pin
// the wire shape (POST body, TTL, CSRF header), the Range fetch (header,
// status branches, capped slice, UTF-8 decode), and the truncation
// signaling (`truncated`, `totalBytes`, Content-Range parsing).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREVIEW_PRESIGN_TTL,
  fetchTextHead,
  parseContentRangeTotal,
  requestPreviewPresignedUrl,
} from "@/hooks/use-preview";
import { PREVIEW_TEXT_BYTE_CAP } from "@/lib/files/preview";
import { ApiClientError } from "@/lib/api/client";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@/lib/auth/csrf-constants";

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
  url: "https://acct.r2.cloudflarestorage.com/buk/k?X-Amz-Signature=zzz",
  expiresAt: 1_716_000_300_000,
};

beforeEach(() => {
  // apiFetch reads `csrf` cookie for mutations — same as use-download.
  vi.stubGlobal("document", { cookie: `${CSRF_COOKIE_NAME}=tok` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PREVIEW_PRESIGN_TTL", () => {
  it("is 300s — short on purpose, pinned to catch drift", () => {
    expect(PREVIEW_PRESIGN_TTL).toBe(300);
  });
});

describe("requestPreviewPresignedUrl", () => {
  it("POSTs op=get with ttl=300 and CSRF header", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SAMPLE_PRESIGN));

    const result = await requestPreviewPresignedUrl({
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      key: "logs/2026/server.log",
    });

    expect(result).toEqual(SAMPLE_PRESIGN);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/r2/presign");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      op: "get",
      cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
      bucket: "primary",
      key: "logs/2026/server.log",
      ttl: 300,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get(CSRF_HEADER_NAME)).toBe("tok");
  });

  it("propagates ApiClientError on a 4xx JSON error", async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            message: "Too many requests",
            requestId: "req-x",
          },
        },
        429,
      ),
    );
    await expect(
      requestPreviewPresignedUrl({
        cid: "01HZX0X0X0X0X0X0X0X0X0X0X0",
        bucket: "primary",
        key: "a.txt",
      }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("parseContentRangeTotal", () => {
  it("parses the slash-suffix as the object total", () => {
    expect(parseContentRangeTotal("bytes 0-1048575/52428800")).toBe(52_428_800);
  });

  it("tolerates extra whitespace", () => {
    expect(parseContentRangeTotal("bytes 0-99/  500")).toBe(500);
  });

  it("returns null for an unknown total ('*')", () => {
    // RFC 7233 lets the server omit the total. Treat as 'unknown' so the
    // dialog falls back to the caller's sizeHint.
    expect(parseContentRangeTotal("bytes 0-1048575/*")).toBeNull();
  });

  it("returns null for missing / malformed values", () => {
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal("garbage")).toBeNull();
    expect(parseContentRangeTotal("bytes 0-100/notanumber")).toBeNull();
  });
});

describe("fetchTextHead", () => {
  function rangeResponse(
    body: BodyInit,
    init: { status: number; headers?: Record<string, string> },
  ): Response {
    return new Response(body, {
      status: init.status,
      headers: init.headers,
    });
  }

  it("sends Range: bytes=0-(cap-1) on the GET", async () => {
    const fetchMock = stubFetch(() =>
      rangeResponse("hello", {
        status: 206,
        headers: {
          "content-range": `bytes 0-${PREVIEW_TEXT_BYTE_CAP - 1}/5`,
        },
      }),
    );
    await fetchTextHead("https://r2/file.txt");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("range")).toBe(`bytes=0-${PREVIEW_TEXT_BYTE_CAP - 1}`);
  });

  it("returns the body and marks truncated=false when total <= cap", async () => {
    stubFetch(() =>
      rangeResponse("short body", {
        status: 206,
        headers: { "content-range": "bytes 0-9/10" },
      }),
    );
    const res = await fetchTextHead("https://r2/file.txt");
    expect(res.text).toBe("short body");
    expect(res.truncated).toBe(false);
    expect(res.totalBytes).toBe(10);
  });

  it("marks truncated=true when total > cap", async () => {
    const total = PREVIEW_TEXT_BYTE_CAP * 5;
    stubFetch(() =>
      rangeResponse("a".repeat(100), {
        status: 206,
        headers: {
          "content-range": `bytes 0-${PREVIEW_TEXT_BYTE_CAP - 1}/${total}`,
        },
      }),
    );
    const res = await fetchTextHead("https://r2/big.log");
    expect(res.truncated).toBe(true);
    expect(res.totalBytes).toBe(total);
  });

  it("slices a misbehaving 200 (Range-ignored) to the cap and marks truncated", async () => {
    // Defensive — if a proxy strips Range and sends the whole 2 MB body,
    // we must not hand 2 MB of text to React state.
    const body = new Uint8Array(PREVIEW_TEXT_BYTE_CAP + 2048);
    body.fill(0x61); // 'a'
    stubFetch(() =>
      rangeResponse(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      }),
    );
    const res = await fetchTextHead("https://r2/big.log");
    expect(res.text.length).toBe(PREVIEW_TEXT_BYTE_CAP);
    expect(res.truncated).toBe(true);
    expect(res.totalBytes).toBe(body.byteLength);
  });

  it("decodes UTF-8 multibyte content correctly", async () => {
    const bytes = new TextEncoder().encode("héllo 你好");
    stubFetch(() =>
      rangeResponse(bytes, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
        },
      }),
    );
    const res = await fetchTextHead("https://r2/intl.txt");
    expect(res.text).toBe("héllo 你好");
    expect(res.truncated).toBe(false);
  });

  it("throws on a non-OK, non-206 status with the server text included", async () => {
    stubFetch(() =>
      rangeResponse("nope", {
        status: 403,
      }),
    );
    await expect(fetchTextHead("https://r2/forbidden.txt")).rejects.toThrow(
      /preview\.fetch_failed: 403/,
    );
  });

  it("marks truncated=true when total is unknown but the body filled the cap", async () => {
    // Some proxies strip Content-Range AND Content-Length. We must assume
    // there's more content rather than telling the user "this is the
    // whole file" when we don't actually know.
    const body = new Uint8Array(PREVIEW_TEXT_BYTE_CAP);
    body.fill(0x62);
    stubFetch(() => rangeResponse(body, { status: 200 }));
    const res = await fetchTextHead("https://r2/no-headers.txt");
    expect(res.text.length).toBe(PREVIEW_TEXT_BYTE_CAP);
    expect(res.truncated).toBe(true);
    expect(res.totalBytes).toBeNull();
  });
});
