// tests/unit/uploads/multipart.test.ts
//
// Tests lib/uploads/multipart.ts. Drives the worker pool through FakeXhr
// instances and asserts: 25 parts for a 250 MB file, no more than 3 active
// XHRs at once, quote-stripped ETags forwarded to /complete, and best-effort
// /abort on user-cancel.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { installFakeXhr, registry, fakeFile, type FakeXhrSent } from "./_fake-xhr";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {
    code: string;
    status: number;
    requestId: string;
    constructor(code: string, message: string, status: number, requestId: string) {
      super(message);
      this.code = code;
      this.status = status;
      this.requestId = requestId;
    }
  },
}));

interface ApiCall {
  url: string;
  init: { method?: string; json?: unknown };
}

describe("lib/uploads/multipart", () => {
  let uninstall: () => void;
  let apiFetchMock: ReturnType<typeof vi.fn>;
  let apiCalls: ApiCall[];
  let uploadMultipart: typeof import("@/lib/uploads/multipart").uploadMultipart;

  beforeEach(async () => {
    uninstall = installFakeXhr();
    vi.resetModules();
    const clientMod = await import("@/lib/api/client");
    apiFetchMock = vi.mocked(clientMod.apiFetch);
    apiCalls = [];
    apiFetchMock.mockReset();
    const mpMod = await import("@/lib/uploads/multipart");
    uploadMultipart = mpMod.uploadMultipart;
  });

  afterEach(() => {
    uninstall();
  });

  function wireDefaultApiResponses(): void {
    apiFetchMock.mockImplementation(async (url: string, init: { method?: string; json?: unknown } = {}) => {
      apiCalls.push({ url, init });
      if (url.endsWith("/api/r2/multipart/create")) {
        return { uploadId: "mp-upload-1" };
      }
      if (url.endsWith("/api/r2/multipart/complete")) {
        return { etag: '"final-abc"', location: "https://r2/loc" };
      }
      if (url.endsWith("/api/r2/multipart/abort")) {
        return undefined;
      }
      if (url.endsWith("/api/r2/presign")) {
        const partNumber = (init.json as { partNumber?: number })?.partNumber ?? 0;
        return { url: `https://r2/u/part-${partNumber}`, expiresAt: 0 };
      }
      throw new Error(`unmocked ${url}`);
    });
  }

  /** Drain XHRs that have called .send() — succeed each with a synthetic
   *  ETag derived from its URL so the test can verify part ordering. Track
   *  the historical peak of concurrent active XHRs along the way. */
  async function drainAndTrackPeak(maxIterations = 1000): Promise<{ peakActive: number }> {
    let peakActive = 0;
    for (let i = 0; i < maxIterations; i++) {
      peakActive = Math.max(peakActive, registry.active.length);
      if (registry.active.length === 0) {
        // Allow any pending microtasks to flush so workers can pick the
        // next part / control-plane call.
        await Promise.resolve();
        await Promise.resolve();
        if (registry.active.length === 0) return { peakActive };
        continue;
      }
      const xhr = registry.active[0]!;
      // Derive a deterministic etag-with-quotes from the URL so we can
      // verify the strip + sort in /complete.
      const match = /part-(\d+)/.exec(xhr.url());
      const partNumber = match ? Number(match[1]) : 0;
      xhr.succeed({ status: 200, headers: { ETag: `"etag-${partNumber}"` } });
      // Let workers pick the next part before the next loop iteration.
      await Promise.resolve();
      await Promise.resolve();
    }
    return { peakActive };
  }

  it("250MB file → 25 parts, 3-part concurrency cap respected, complete called with sorted+stripped etags", async () => {
    wireDefaultApiResponses();
    const file = fakeFile("big.bin", 250 * 1024 * 1024);
    const ac = new AbortController();

    const promise = uploadMultipart(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "big.bin", file },
      {
        signal: ac.signal,
        onUploadIdReady: vi.fn(),
        onPartProgress: vi.fn(),
      },
    );

    const { peakActive } = await drainAndTrackPeak();
    const result = await promise;

    expect(result.uploadId).toBe("mp-upload-1");
    expect(peakActive).toBeLessThanOrEqual(3);
    expect(peakActive).toBe(3);

    // 25 part presigns + 1 create + 1 complete = 27 control calls
    const presignCalls = apiCalls.filter((c) => c.url.endsWith("/api/r2/presign"));
    expect(presignCalls).toHaveLength(25);
    const createCalls = apiCalls.filter((c) => c.url.endsWith("/api/r2/multipart/create"));
    expect(createCalls).toHaveLength(1);
    const completeCalls = apiCalls.filter((c) => c.url.endsWith("/api/r2/multipart/complete"));
    expect(completeCalls).toHaveLength(1);

    const completeJson = completeCalls[0]!.init.json as {
      parts: Array<{ partNumber: number; etag: string }>;
    };
    // 25 parts, sorted ascending by partNumber, etags quote-stripped.
    expect(completeJson.parts).toHaveLength(25);
    expect(completeJson.parts.map((p) => p.partNumber)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(completeJson.parts[0]!.etag).toBe("etag-1");
    expect(completeJson.parts.at(-1)!.etag).toBe("etag-25");
    for (const part of completeJson.parts) {
      expect(part.etag.startsWith('"')).toBe(false);
    }
  });

  it("fires onUploadIdReady BEFORE the first part's XHR send", async () => {
    wireDefaultApiResponses();
    const order: string[] = [];
    const onUploadIdReady = vi.fn(() => {
      order.push("uploadIdReady");
    });

    const original = registry.onSend;
    registry.onSend = (xhr) => {
      order.push(`xhr-send-${xhr.url()}`);
    };

    const file = fakeFile("a.bin", 30 * 1024 * 1024);
    const ac = new AbortController();
    const promise = uploadMultipart(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a.bin", file },
      {
        signal: ac.signal,
        onUploadIdReady,
        onPartProgress: vi.fn(),
      },
    );

    await drainAndTrackPeak();
    await promise;
    registry.onSend = original;

    expect(onUploadIdReady).toHaveBeenCalledWith("mp-upload-1");
    expect(order[0]).toBe("uploadIdReady");
    expect(order[1]).toMatch(/^xhr-send-https:\/\/r2\/u\/part-/);
  });

  it("cancel during upload fires /api/r2/multipart/abort", async () => {
    wireDefaultApiResponses();
    const file = fakeFile("big.bin", 100 * 1024 * 1024); // 10 parts
    const ac = new AbortController();
    const promise = uploadMultipart(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "big.bin", file },
      {
        signal: ac.signal,
        onUploadIdReady: vi.fn(),
        onPartProgress: vi.fn(),
      },
    );

    // Let create + first round of 3 part-presigns + 3 XHR opens land.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(registry.active.length).toBeGreaterThan(0);

    ac.abort();

    // Walk pending microtasks until the helper settles. The active XHRs
    // each receive onabort via the shared signal.
    let result: Error | { uploadId: string } | undefined;
    await promise.then(
      (r) => {
        result = r;
      },
      (e: Error) => {
        result = e;
      },
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error & { kind?: string }).kind).toBe("aborted");

    const abortCalls = apiCalls.filter((c) => c.url.endsWith("/api/r2/multipart/abort"));
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0]!.init.json).toMatchObject({ uploadId: "mp-upload-1" });
  });

  it("propagates HTTP failure on /complete as kind='http' and best-effort calls /abort", async () => {
    apiFetchMock.mockImplementation(async (url: string, init: { method?: string; json?: unknown } = {}) => {
      apiCalls.push({ url, init });
      if (url.endsWith("/api/r2/multipart/create")) {
        return { uploadId: "mp-X" };
      }
      if (url.endsWith("/api/r2/multipart/complete")) {
        const ApiClientError = (await import("@/lib/api/client")).ApiClientError;
        throw new ApiClientError("upload.complete_failed", "S3 said no", 500, "req-1");
      }
      if (url.endsWith("/api/r2/multipart/abort")) return undefined;
      if (url.endsWith("/api/r2/presign")) {
        const partNumber = (init.json as { partNumber?: number })?.partNumber ?? 0;
        return { url: `https://r2/u/part-${partNumber}`, expiresAt: 0 };
      }
      throw new Error(`unmocked ${url}`);
    });

    const file = fakeFile("a.bin", 30 * 1024 * 1024); // 3 parts
    const ac = new AbortController();
    const promise = uploadMultipart(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a.bin", file },
      { signal: ac.signal, onUploadIdReady: vi.fn(), onPartProgress: vi.fn() },
    );

    await drainAndTrackPeak();
    const err = await promise.catch((e: Error) => e);

    expect((err as Error & { kind?: string }).kind).toBe("http");
    const aborts = apiCalls.filter((c) => c.url.endsWith("/api/r2/multipart/abort"));
    expect(aborts).toHaveLength(1);
  });

  it("verifies sent body sizes for the final part are the trailing remainder", async () => {
    wireDefaultApiResponses();
    // 15 MB file → 2 parts: part 1 = 10MB, part 2 = 5MB.
    const file = fakeFile("a.bin", 15 * 1024 * 1024);
    const ac = new AbortController();
    const promise = uploadMultipart(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a.bin", file },
      { signal: ac.signal, onUploadIdReady: vi.fn(), onPartProgress: vi.fn() },
    );
    await drainAndTrackPeak();
    await promise;

    const sent: FakeXhrSent[] = registry.sent.filter((s) =>
      s.url.startsWith("https://r2/u/part-"),
    );
    expect(sent).toHaveLength(2);
    // sent[0] is part-1, sent[1] is part-2 (in send order).
    expect((sent[0]!.body as Blob).size).toBe(10 * 1024 * 1024);
    expect((sent[1]!.body as Blob).size).toBe(5 * 1024 * 1024);
  });
});
