// tests/unit/uploads/dispatcher.test.ts
//
// Tests lib/uploads/dispatcher.ts focusing on file-level concurrency and
// status-machine wiring. The upload helpers are mocked at the module
// boundary so we don't have to drive FakeXhr per part — the dispatcher's
// contract is "coordinate 3 in flight tasks, route to single/multipart by
// size, write the right status", not "upload bytes".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { fakeFile } from "./_fake-xhr";

vi.mock("@/lib/uploads/single-put", async () => {
  const actual = await vi.importActual<typeof import("@/lib/uploads/single-put")>(
    "@/lib/uploads/single-put",
  );
  return {
    ...actual,
    uploadSinglePut: vi.fn(),
  };
});

vi.mock("@/lib/uploads/multipart", async () => {
  const actual = await vi.importActual<typeof import("@/lib/uploads/multipart")>(
    "@/lib/uploads/multipart",
  );
  return {
    ...actual,
    uploadMultipart: vi.fn(),
  };
});

describe("lib/uploads/dispatcher", () => {
  let store: typeof import("@/stores/upload-queue");
  let dispatcher: typeof import("@/lib/uploads/dispatcher");
  let singlePutMod: typeof import("@/lib/uploads/single-put");
  let multipartMod: typeof import("@/lib/uploads/multipart");

  beforeEach(async () => {
    vi.resetModules();
    store = await import("@/stores/upload-queue");
    dispatcher = await import("@/lib/uploads/dispatcher");
    singlePutMod = await import("@/lib/uploads/single-put");
    multipartMod = await import("@/lib/uploads/multipart");
    vi.mocked(singlePutMod.uploadSinglePut).mockReset();
    vi.mocked(multipartMod.uploadMultipart).mockReset();
  });

  afterEach(() => {
    dispatcher.stopUploadDispatcher();
  });

  /** Build a deferred so the test can hold a task in 'uploading' status
   *  until released. Returns a runner that, when called, resolves the
   *  uploadSinglePut helper with a synthetic ETag. */
  function makeHeldSinglePut() {
    const deferreds: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    vi.mocked(singlePutMod.uploadSinglePut).mockImplementation(() => {
      return new Promise<{ etag: string }>((resolve, reject) => {
        deferreds.push({
          resolve: () => resolve({ etag: "ok" }),
          reject,
        });
      });
    });
    return deferreds;
  }

  it("5 queued files → exactly 3 in-flight at any moment", async () => {
    const held = makeHeldSinglePut();
    const ids = store.useUploadQueueStore.getState().enqueueMany(
      "01HF000000000000000000000A",
      "buk",
      Array.from({ length: 5 }, (_, i) => fakeFile(`f${i}`, 1024)),
      (f) => f.name,
    );

    dispatcher.startUploadDispatcher();
    // Let microtask + scheduling drain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatcher._inFlightCountForTest()).toBe(3);

    // The 3 active tasks have status 'uploading' (or 'preparing' for the
    // very brief window before runTask flips it). The other 2 stay 'queued'.
    const statuses = ids.map((id) => store.useUploadQueueStore.getState().tasks.get(id)?.status);
    const inFlightCount = statuses.filter((s) => s === "uploading" || s === "preparing").length;
    const queuedCount = statuses.filter((s) => s === "queued").length;
    expect(inFlightCount).toBe(3);
    expect(queuedCount).toBe(2);

    // Release them all so the dispatcher tears down cleanly. The dispatcher
    // claims the remaining 2 queued tasks after each release, so we drain
    // by repeatedly resolving the head of the held queue.
    while (held.length > 0) {
      held.shift()!.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await dispatcher._drainForTest();
  });

  it("after one in-flight completes, the next queued task is picked up", async () => {
    const held = makeHeldSinglePut();
    const ids = store.useUploadQueueStore.getState().enqueueMany(
      "01HF000000000000000000000A",
      "buk",
      Array.from({ length: 4 }, (_, i) => fakeFile(`f${i}`, 1024)),
      (f) => f.name,
    );

    dispatcher.startUploadDispatcher();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatcher._inFlightCountForTest()).toBe(3);

    held.shift()!.resolve();
    // Several microtasks for the .finally() to delete + schedule + claim
    // to land.
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(dispatcher._inFlightCountForTest()).toBe(3);
    expect(store.useUploadQueueStore.getState().tasks.get(ids[0]!)?.status).toBe("done");

    while (held.length > 0) {
      held.shift()!.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await dispatcher._drainForTest();
  });

  it("routes < 100 MB through single-PUT, >= 100 MB through multipart", async () => {
    const singleSpy = vi
      .mocked(singlePutMod.uploadSinglePut)
      .mockResolvedValue({ etag: "small" });
    const multipartSpy = vi
      .mocked(multipartMod.uploadMultipart)
      .mockResolvedValue({ uploadId: "mp-1", etag: "big", location: null });

    const smallId = store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("small.bin", 50 * 1024 * 1024),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "small.bin",
    });
    const bigId = store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("big.bin", 200 * 1024 * 1024),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "big.bin",
    });

    dispatcher.startUploadDispatcher();
    await dispatcher._drainForTest();

    expect(singleSpy).toHaveBeenCalledTimes(1);
    expect(multipartSpy).toHaveBeenCalledTimes(1);
    expect(store.useUploadQueueStore.getState().tasks.get(smallId)?.status).toBe("done");
    expect(store.useUploadQueueStore.getState().tasks.get(bigId)?.status).toBe("done");
  });

  it("UploadError(kind='aborted') from the helper maps to status 'canceled'", async () => {
    const { UploadError } = singlePutMod;
    vi.mocked(singlePutMod.uploadSinglePut).mockRejectedValueOnce(
      new UploadError("aborted", "user clicked X"),
    );
    const id = store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1024),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    dispatcher.startUploadDispatcher();
    await dispatcher._drainForTest();

    expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe("canceled");
  });

  it("UploadError(kind='http') from the helper maps to status 'failed' with the message", async () => {
    const { UploadError } = singlePutMod;
    vi.mocked(singlePutMod.uploadSinglePut).mockRejectedValueOnce(
      new UploadError("http", "HTTP 500 — R2 boom", 500),
    );
    const id = store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1024),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    dispatcher.startUploadDispatcher();
    await dispatcher._drainForTest();

    const task = store.useUploadQueueStore.getState().tasks.get(id);
    expect(task?.status).toBe("failed");
    expect(task?.errorMsg).toMatch(/HTTP 500/);
  });

  it("a cancel during 'uploading' wins over the helper's eventual error throw", async () => {
    const held = makeHeldSinglePut();
    const id = store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1024),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    dispatcher.startUploadDispatcher();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe("uploading");

    store.useUploadQueueStore.getState().cancel(id);
    expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe("canceled");

    // Helper now rejects with kind='http' — the dispatcher must NOT overwrite
    // the 'canceled' status with 'failed'.
    const { UploadError } = singlePutMod;
    held[0]!.reject(new UploadError("http", "after-the-fact 500", 500));
    await dispatcher._drainForTest();

    expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe("canceled");
  });

  it("startUploadDispatcher is idempotent (second call doesn't double-subscribe)", () => {
    const stop1 = dispatcher.startUploadDispatcher();
    const stop2 = dispatcher.startUploadDispatcher();
    // Both calls return a stop function. The module-level guard means
    // stop1 === stop2 (same function reference).
    expect(stop1).toBe(stop2);
  });
});
