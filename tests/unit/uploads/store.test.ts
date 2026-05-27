// tests/unit/uploads/store.test.ts
//
// Pure-state tests for stores/upload-queue.ts. No XHR mocking — the store
// doesn't touch the network. Each test creates a fresh useUploadQueueStore
// instance by resetting the persisted module via vi.resetModules() and a
// dynamic import, so state never leaks across cases.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { fakeFile } from "./_fake-xhr";

async function importFreshStore() {
  vi.resetModules();
  return await import("@/stores/upload-queue");
}

describe("stores/upload-queue", () => {
  let store: Awaited<ReturnType<typeof importFreshStore>>;

  beforeEach(async () => {
    store = await importFreshStore();
  });

  describe("enqueue", () => {
    it("creates a task in 'queued' status with totalBytes from file.size", () => {
      const file = fakeFile("hello.txt", 1024);
      const id = store.useUploadQueueStore.getState().enqueue({
        file,
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "hello.txt",
      });

      const task = store.useUploadQueueStore.getState().tasks.get(id);
      expect(task).toBeDefined();
      expect(task?.status).toBe("queued");
      expect(task?.totalBytes).toBe(1024);
      expect(task?.bytesUploaded).toBe(0);
      expect(task?.parts.size).toBe(0);
      expect(task?.cid).toBe("01HF000000000000000000000A");
    });

    it("enqueueMany returns ids in input order", () => {
      const files = [fakeFile("a", 1), fakeFile("b", 1), fakeFile("c", 1)];
      const ids = store.useUploadQueueStore
        .getState()
        .enqueueMany(
          "01HF000000000000000000000A",
          "buk",
          files,
          (f) => `prefix/${f.name}`,
        );

      expect(ids).toHaveLength(3);
      const tasks = ids.map((id) =>
        store.useUploadQueueStore.getState().tasks.get(id),
      );
      expect(tasks.map((t) => t?.key)).toEqual([
        "prefix/a",
        "prefix/b",
        "prefix/c",
      ]);
    });
  });

  describe("cancel", () => {
    it("marks task 'canceled' and fires the attached AbortController", () => {
      const id = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("a", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "a",
      });

      const ac = new AbortController();
      const abortSpy = vi.spyOn(ac, "abort");
      store.useUploadQueueStore.getState().setAbortController(id, ac);
      store.useUploadQueueStore.getState().cancel(id);

      expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe(
        "canceled",
      );
      expect(abortSpy).toHaveBeenCalledOnce();
    });

    it("is idempotent against terminal statuses (won't flip 'done' to 'canceled')", () => {
      const id = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("a", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "a",
      });
      store.useUploadQueueStore.getState().setStatus(id, "done");
      store.useUploadQueueStore.getState().cancel(id);
      expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe(
        "done",
      );
    });
  });

  describe("retry", () => {
    it("re-queues a failed task with fresh parts/progress/controller", () => {
      const id = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("a", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "a",
      });
      store.useUploadQueueStore.getState().setError(id, "boom");
      store.useUploadQueueStore.getState().setProgress(id, 500);
      store.useUploadQueueStore
        .getState()
        .setPart(id, 1, { etag: "abc", status: "done" });

      store.useUploadQueueStore.getState().retry(id);
      const task = store.useUploadQueueStore.getState().tasks.get(id);
      expect(task?.status).toBe("queued");
      expect(task?.errorMsg).toBeUndefined();
      expect(task?.parts.size).toBe(0);
      expect(task?.bytesUploaded).toBe(0);
      expect(task?.abortController).toBeUndefined();
    });

    it("is a no-op for tasks not in failed/canceled status", () => {
      const id = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("a", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "a",
      });
      // Status is 'queued'.
      store.useUploadQueueStore.getState().retry(id);
      // Still 'queued' — no thrash, but also no error.
      expect(store.useUploadQueueStore.getState().tasks.get(id)?.status).toBe(
        "queued",
      );
    });
  });

  describe("removeDone / removeOne", () => {
    it("removeDone drops only tasks in 'done' status", () => {
      const a = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("a", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "a",
      });
      const b = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("b", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "b",
      });
      store.useUploadQueueStore.getState().setStatus(a, "done");
      store.useUploadQueueStore.getState().setStatus(b, "failed");
      store.useUploadQueueStore.getState().removeDone();

      const ids = [...store.useUploadQueueStore.getState().tasks.keys()];
      expect(ids).toEqual([b]);
    });

    it("removeOne refuses to drop an in-flight (non-terminal) task", () => {
      const id = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("a", 1),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "a",
      });
      store.useUploadQueueStore.getState().setStatus(id, "uploading");
      store.useUploadQueueStore.getState().removeOne(id);
      expect(store.useUploadQueueStore.getState().tasks.has(id)).toBe(true);

      store.useUploadQueueStore.getState().setStatus(id, "failed");
      store.useUploadQueueStore.getState().removeOne(id);
      expect(store.useUploadQueueStore.getState().tasks.has(id)).toBe(false);
    });
  });

  describe("toUploadDrawerTask adapter", () => {
    it("maps internal 'preparing' status to drawer 'queued'", () => {
      const id = store.useUploadQueueStore.getState().enqueue({
        file: fakeFile("hello/world.txt", 1024),
        cid: "01HF000000000000000000000A",
        bucket: "buk",
        key: "hello/world.txt",
      });
      store.useUploadQueueStore.getState().setStatus(id, "preparing");
      const internal = store.useUploadQueueStore.getState().tasks.get(id);
      expect(internal).toBeDefined();
      const drawer = store.toUploadDrawerTask(internal as never);
      expect(drawer.status).toBe("queued");
      // Filename derived from key trailing segment.
      expect(drawer.filename).toBe("world.txt");
    });
  });
});
