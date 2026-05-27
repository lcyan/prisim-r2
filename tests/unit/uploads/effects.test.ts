// tests/unit/uploads/effects.test.ts
//
// Tests for lib/uploads/effects.ts — the two browser-side side effects
// the UploadQueueProvider mounts (auto-remove done tasks after 5 s,
// beforeunload guard while uploads are in flight). We test them in
// isolation by:
//   * resetting the Zustand store module per case (vi.resetModules)
//     so each test owns its own task map
//   * driving timers manually via vi.useFakeTimers + vi.advanceTimersByTime
//     for the auto-remove case
//   * passing a stub BeforeUnloadHost (just { addEventListener,
//     removeEventListener }) for the unload-guard case — no jsdom
//     needed, and the test owns the listener registry directly.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeFile } from "./_fake-xhr";

async function importFreshModules() {
  vi.resetModules();
  const store = await import("@/stores/upload-queue");
  const effects = await import("@/lib/uploads/effects");
  return { store, effects };
}

describe("lib/uploads/effects.startAutoRemoveDone", () => {
  let mods: Awaited<ReturnType<typeof importFreshModules>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    mods = await importFreshModules();
  });

  it("schedules removeOne 5 s after a task enters 'done'", () => {
    const stop = mods.effects.startAutoRemoveDone();

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    // Mark the task complete so the effect schedules a removal.
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    expect(mods.store.useUploadQueueStore.getState().tasks.has(id)).toBe(true);

    // 4 999 ms — not yet fired.
    vi.advanceTimersByTime(4_999);
    expect(mods.store.useUploadQueueStore.getState().tasks.has(id)).toBe(true);

    // Cross the 5 s mark — task should be removed.
    vi.advanceTimersByTime(1);
    expect(mods.store.useUploadQueueStore.getState().tasks.has(id)).toBe(false);

    stop();
  });

  it("does not re-schedule for tasks already in 'done' on subscribe ticks", () => {
    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");

    const stop = mods.effects.startAutoRemoveDone();
    // After 5 s the task should be removed (initial pass picks it up).
    vi.advanceTimersByTime(5_000);
    expect(mods.store.useUploadQueueStore.getState().tasks.has(id)).toBe(false);

    stop();
  });

  it("cancels a pending removal when the task is retried before 5 s", () => {
    const stop = mods.effects.startAutoRemoveDone();
    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });

    // Drive to done, then partway through the 5 s window flip back via
    // setError + retry (retry only re-queues failed/canceled tasks, so
    // we go via setError first to legally retry).
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    vi.advanceTimersByTime(2_000);
    mods.store.useUploadQueueStore.getState().setError(id, "manual fail");
    // setError → status='failed'; retry → status='queued'
    mods.store.useUploadQueueStore.getState().retry(id);
    // Cross the original 5 s deadline.
    vi.advanceTimersByTime(5_000);

    // Task should still exist because the removal was cancelled.
    const task = mods.store.useUploadQueueStore.getState().tasks.get(id);
    expect(task).toBeDefined();
    expect(task?.status).toBe("queued");

    stop();
  });

  it("the returned stop() cancels pending timers and stops further work", () => {
    const stop = mods.effects.startAutoRemoveDone();

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");

    stop(); // before the timer fires

    vi.advanceTimersByTime(10_000);
    expect(mods.store.useUploadQueueStore.getState().tasks.has(id)).toBe(true);
  });
});

describe("lib/uploads/effects.startBeforeUnloadGuard", () => {
  let mods: Awaited<ReturnType<typeof importFreshModules>>;
  let host: ReturnType<typeof makeStubHost>;

  beforeEach(async () => {
    mods = await importFreshModules();
    host = makeStubHost();
  });

  it("registers a beforeunload listener when a task is in flight", () => {
    const stop = mods.effects.startBeforeUnloadGuard({ host });
    expect(host.listeners()).toHaveLength(0);

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1024),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    // 'queued' counts as in-flight per the effect's contract.
    expect(host.listeners()).toHaveLength(1);

    // Take the task to 'done' — listener should drop.
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    expect(host.listeners()).toHaveLength(0);

    stop();
  });

  it("does not attach a listener when the queue starts empty", () => {
    const stop = mods.effects.startBeforeUnloadGuard({ host });
    expect(host.listeners()).toHaveLength(0);
    stop();
    expect(host.listeners()).toHaveLength(0);
  });

  it("only attaches once even if multiple tasks enter the queue", () => {
    const stop = mods.effects.startBeforeUnloadGuard({ host });
    const ids = mods.store.useUploadQueueStore
      .getState()
      .enqueueMany(
        "01HF000000000000000000000A",
        "buk",
        [fakeFile("a", 1), fakeFile("b", 1), fakeFile("c", 1)],
        (f) => f.name,
      );
    expect(ids).toHaveLength(3);
    expect(host.listeners()).toHaveLength(1);
    stop();
  });

  it("the listener calls preventDefault and sets returnValue", () => {
    const stop = mods.effects.startBeforeUnloadGuard({ host });
    mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });

    const listener = host.listeners()[0]!;
    const fakeEvent = {
      preventDefault: vi.fn(),
      returnValue: undefined as unknown,
    };
    listener(fakeEvent as unknown as Event);
    expect(fakeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fakeEvent.returnValue).toBe("");

    stop();
  });

  it("stop() removes the listener and unsubscribes", () => {
    const stop = mods.effects.startBeforeUnloadGuard({ host });
    mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    expect(host.listeners()).toHaveLength(1);

    stop();
    expect(host.listeners()).toHaveLength(0);

    // After stop(), further store mutations should not re-register.
    mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("b.bin", 100),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "b.bin",
    });
    expect(host.listeners()).toHaveLength(0);
  });
});

/* ─── test stub ─────────────────────────────────────────────── */

/** Stand-in for `window` that records currently-attached beforeunload
 *  listeners. The effect can be exercised under the node Vitest
 *  environment without pulling in jsdom. */
function makeStubHost() {
  const set = new Set<(e: Event) => void>();
  return {
    addEventListener: (type: "beforeunload", listener: (e: Event) => void) => {
      if (type !== "beforeunload") return;
      set.add(listener);
    },
    removeEventListener: (
      type: "beforeunload",
      listener: (e: Event) => void,
    ) => {
      if (type !== "beforeunload") return;
      set.delete(listener);
    },
    listeners(): Array<(e: Event) => void> {
      return [...set];
    },
  };
}

describe("lib/uploads/effects.startInvalidateOnDone", () => {
  let mods: Awaited<ReturnType<typeof importFreshModules>>;

  beforeEach(async () => {
    // No fake timers here — the effect is synchronous against store changes.
    mods = await importFreshModules();
  });

  it("invalidates with ['objects', cid, bucket, prefix] when a task reaches 'done'", () => {
    const invalidate = vi.fn();
    const stop = mods.effects.startInvalidateOnDone(invalidate);

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("baz.txt", 1),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "foo/bar/baz.txt",
    });
    expect(invalidate).not.toHaveBeenCalled();

    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith([
      "objects",
      "01HF000000000000000000000A",
      "buk",
      "foo/bar/",
    ]);

    stop();
  });

  it("uses an empty prefix for a top-level key (no slash)", () => {
    const invalidate = vi.fn();
    const stop = mods.effects.startInvalidateOnDone(invalidate);

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("top.txt", 1),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "top.txt",
    });
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    expect(invalidate).toHaveBeenCalledWith([
      "objects",
      "01HF000000000000000000000A",
      "buk",
      "",
    ]);

    stop();
  });

  it("does not double-invalidate when the same 'done' task is observed on a later tick", () => {
    const invalidate = vi.fn();
    const stop = mods.effects.startInvalidateOnDone(invalidate);

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    expect(invalidate).toHaveBeenCalledOnce();

    // An unrelated store mutation re-runs handleChange. The first task is
    // still `done` but we already fired for it — second call must NOT
    // re-fire for the same id.
    mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("b.bin", 1),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "b.bin",
    });
    expect(invalidate).toHaveBeenCalledOnce();

    stop();
  });

  it("does not invalidate for tasks that never reach 'done'", () => {
    const invalidate = vi.fn();
    const stop = mods.effects.startInvalidateOnDone(invalidate);

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    mods.store.useUploadQueueStore.getState().setStatus(id, "uploading");
    mods.store.useUploadQueueStore.getState().setError(id, "boom");
    expect(invalidate).not.toHaveBeenCalled();

    stop();
  });

  it("stop() unsubscribes — later transitions do not invalidate", () => {
    const invalidate = vi.fn();
    const stop = mods.effects.startInvalidateOnDone(invalidate);
    stop();

    const id = mods.store.useUploadQueueStore.getState().enqueue({
      file: fakeFile("a.bin", 1),
      cid: "01HF000000000000000000000A",
      bucket: "buk",
      key: "a.bin",
    });
    mods.store.useUploadQueueStore.getState().setStatus(id, "done");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
