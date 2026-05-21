// tests/unit/uploads/single-put.test.ts
//
// Tests lib/uploads/single-put.ts. Mocks @/lib/api/client.apiFetch and
// installs FakeXhr as global.XMLHttpRequest. Each test drives the FakeXhr
// instance through to a terminal state and asserts the helper's return /
// throw shape.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { installFakeXhr, registry, fakeFile } from "./_fake-xhr";

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

describe("lib/uploads/single-put", () => {
  let uninstall: () => void;
  let apiFetchMock: ReturnType<typeof vi.fn>;
  let uploadSinglePut: typeof import("@/lib/uploads/single-put").uploadSinglePut;
  let UploadError: typeof import("@/lib/uploads/single-put").UploadError;
  let stripEtagQuotes: typeof import("@/lib/uploads/single-put").stripEtagQuotes;

  beforeEach(async () => {
    uninstall = installFakeXhr();
    vi.resetModules();
    const clientMod = await import("@/lib/api/client");
    apiFetchMock = vi.mocked(clientMod.apiFetch);
    apiFetchMock.mockReset();
    const mod = await import("@/lib/uploads/single-put");
    uploadSinglePut = mod.uploadSinglePut;
    UploadError = mod.UploadError;
    stripEtagQuotes = mod.stripEtagQuotes;
  });

  afterEach(() => {
    uninstall();
  });

  it("strips surrounding quotes from ETag header", () => {
    expect(stripEtagQuotes('"abc123"')).toBe("abc123");
    expect(stripEtagQuotes("abc123")).toBe("abc123");
    expect(stripEtagQuotes("")).toBe("");
  });

  it("happy path: presign, PUT, returns quote-stripped ETag", async () => {
    apiFetchMock.mockResolvedValueOnce({ url: "https://r2.example/u", expiresAt: Date.now() + 900_000 });
    const ac = new AbortController();
    const file = fakeFile("a.bin", 100);

    const promise = uploadSinglePut(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a.bin", file },
      { signal: ac.signal, onProgress: vi.fn() },
    );

    // Wait one microtask for apiFetch + xhr.send().
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.active).toHaveLength(1);
    const xhr = registry.active[0]!;
    expect(xhr.url()).toBe("https://r2.example/u");

    xhr.fireProgress(50);
    xhr.fireProgress(100);
    xhr.succeed({ status: 200, headers: { ETag: '"abc123"' } });

    await expect(promise).resolves.toEqual({ etag: "abc123" });
  });

  it("calls onProgress only with lengthComputable events", async () => {
    apiFetchMock.mockResolvedValueOnce({ url: "https://r2/u", expiresAt: 0 });
    const onProgress = vi.fn();
    const ac = new AbortController();

    const promise = uploadSinglePut(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a", file: fakeFile("a", 200) },
      { signal: ac.signal, onProgress },
    );
    await Promise.resolve();
    await Promise.resolve();

    const xhr = registry.active[0]!;
    xhr.fireProgress(50);
    xhr.fireProgress(150);
    xhr.succeed({ headers: { ETag: '"x"' } });
    await promise;

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 50);
    expect(onProgress).toHaveBeenNthCalledWith(2, 150);
  });

  it("throws UploadError kind='aborted' if signal is aborted before start", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      uploadSinglePut(
        { cid: "01HF000000000000000000000A", bucket: "buk", key: "a", file: fakeFile("a", 100) },
        { signal: ac.signal, onProgress: vi.fn() },
      ),
    ).rejects.toMatchObject({ name: "UploadError", kind: "aborted" });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("non-2xx response throws kind='http' with status", async () => {
    apiFetchMock.mockResolvedValueOnce({ url: "https://r2/u", expiresAt: 0 });
    const ac = new AbortController();
    const promise = uploadSinglePut(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a", file: fakeFile("a", 100) },
      { signal: ac.signal, onProgress: vi.fn() },
    );
    await Promise.resolve();
    await Promise.resolve();
    registry.active[0]!.fail(403, "<Error><Code>AccessDenied</Code></Error>");

    await expect(promise).rejects.toMatchObject({
      name: "UploadError",
      kind: "http",
      status: 403,
    });
  });

  it("network error throws kind='network'", async () => {
    apiFetchMock.mockResolvedValueOnce({ url: "https://r2/u", expiresAt: 0 });
    const ac = new AbortController();
    const promise = uploadSinglePut(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a", file: fakeFile("a", 100) },
      { signal: ac.signal, onProgress: vi.fn() },
    );
    await Promise.resolve();
    await Promise.resolve();
    registry.active[0]!.networkError();

    await expect(promise).rejects.toMatchObject({ kind: "network" });
  });

  it("missing ETag header on a 200 response throws kind='http' (CORS expose hint)", async () => {
    apiFetchMock.mockResolvedValueOnce({ url: "https://r2/u", expiresAt: 0 });
    const ac = new AbortController();
    const promise = uploadSinglePut(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a", file: fakeFile("a", 100) },
      { signal: ac.signal, onProgress: vi.fn() },
    );
    await Promise.resolve();
    await Promise.resolve();
    registry.active[0]!.succeed({ status: 200, headers: {} });

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/ETag/i);
  });

  it("mid-upload abort calls xhr.abort() and rejects with kind='aborted'", async () => {
    apiFetchMock.mockResolvedValueOnce({ url: "https://r2/u", expiresAt: 0 });
    const ac = new AbortController();
    const promise = uploadSinglePut(
      { cid: "01HF000000000000000000000A", bucket: "buk", key: "a", file: fakeFile("a", 100) },
      { signal: ac.signal, onProgress: vi.fn() },
    );
    await Promise.resolve();
    await Promise.resolve();
    const xhr = registry.active[0]!;
    ac.abort();
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    // xhr.abort() triggered onabort which removed it from registry.active.
    expect(registry.active).not.toContain(xhr);
  });
});
