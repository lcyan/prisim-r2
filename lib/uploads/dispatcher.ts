// lib/uploads/dispatcher.ts
//
// Idempotent worker loop that owns the lifecycle of every upload task in
// the Zustand store. The store carries state; this module carries motion.
//
// Concurrency model (PRD §"3×3 并发"):
//   * FILE_CONCURRENCY = 3 — at most three tasks transitioning past 'queued'
//     at any given time.
//   * Each task internally drives its own per-part concurrency via the
//     multipart helper (PART_CONCURRENCY = 3). The two limits compose to
//     the documented 9 in-flight HTTP requests cap per browser tab.
//
// Lifecycle (per task):
//   queued → preparing → uploading → completing → done
//                         ↘ failed       ↘ failed
//                         ↘ canceled    ↘ canceled
//
//   * 'preparing' is the instant between the dispatcher claiming a task
//     and the first byte being sent — used as the claim mutex so a
//     concurrent subscribe tick doesn't re-claim the same task.
//   * 'completing' is only set during the multipart complete call; the
//     drawer renders it as a distinct visual state ("finalizing").
//
// Idempotency:
//   * Module-level `started` boolean guards startUploadDispatcher() so
//     re-mounting the provider component in dev / strict mode doesn't
//     attach a second store subscription.
//   * The schedule() function is debounced via queueMicrotask so a burst
//     of subscribe ticks (a single enqueueMany() can fire 1 set() but
//     consumers may also dispatch) results in exactly one claim pass.
//
// Cancellation:
//   * The store's cancel() action calls abortController.abort() immediately.
//     The dispatcher observes the resulting UploadError(kind='aborted')
//     and refuses to overwrite the 'canceled' status the store already
//     wrote — the user already saw their click take effect.
//
// What this module deliberately does NOT do:
//   * No retry loop. Failed tasks stay in 'failed' until the user clicks
//     retry, which re-queues them.
//   * No persistence. Tab close ends all uploads — see stores/upload-queue.ts
//     for the rationale.
//   * No SSR. The module reads from a browser-only store and starts a
//     browser-only subscription. Importing it from server code is a bug.

import {
  useUploadQueueStore,
  type UploadTaskInternal,
  type UploadStatus,
} from "@/stores/upload-queue";

import { UploadError } from "./single-put";
import { uploadSinglePut } from "./single-put";
import { MULTIPART_THRESHOLD_BYTES, uploadMultipart } from "./multipart";

/* ─── concurrency limits ─────────────────────────────────────── */

/** Maximum number of files in flight at once. */
export const FILE_CONCURRENCY = 3;

/** Minimum interval between store.setProgress writes per task. 200 ms is
 *  fast enough that the bar feels live and slow enough that 5 large files
 *  uploading simultaneously won't flood React with re-renders. */
const PROGRESS_FLUSH_INTERVAL_MS = 200;

/* ─── module-level state ─────────────────────────────────────── */

let started = false;
let unsubscribe: (() => void) | null = null;

/** In-flight tracking. Keyed by task id; value is the worker promise so we
 *  can await pending work in tests. Never read by application code. */
const inFlight = new Map<string, Promise<void>>();

/** Per-task progress flush bookkeeping. Independent of the in-flight map
 *  because progress callbacks may arrive after the worker resolves (xhr
 *  upload.onprogress can land in the same turn as xhr.onload). */
interface ProgressState {
  lastFlushAt: number;
  /** For multipart: per-part byte counter. Sum used for total bytes. */
  partBytes: Map<number, number>;
}
const progressByTask = new Map<string, ProgressState>();

/* ─── public surface ─────────────────────────────────────────── */

/**
 * Start the dispatcher. Safe to call multiple times — subsequent calls are
 * no-ops. Returns a stop() function for tests; production code never stops
 * the dispatcher.
 */
export function startUploadDispatcher(): () => void {
  if (started) {
    return stopUploadDispatcher;
  }
  started = true;

  // Initial pass — if the store already has queued tasks (e.g. hot reload),
  // pick them up without waiting for the next state change.
  schedule();

  unsubscribe = useUploadQueueStore.subscribe(() => {
    schedule();
  });

  return stopUploadDispatcher;
}

/** Tear down the subscription. Intended for tests only. Clears in-flight
 *  tracking but does NOT abort running uploads — call store.cancel(id) for
 *  each task first if that's what you want. */
export function stopUploadDispatcher(): void {
  if (!started) return;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  inFlight.clear();
  progressByTask.clear();
}

/* ─── scheduling ─────────────────────────────────────────────── */

let scheduledTick = false;

/** Coalesce a burst of subscribe ticks into one claim pass per microtask.
 *  Without this, enqueueMany() calling set() once still triggers the
 *  subscriber once, but in dev with React strict mode the same effect
 *  fires twice and would double-claim if not coalesced. */
function schedule(): void {
  if (scheduledTick) return;
  scheduledTick = true;
  queueMicrotask(() => {
    scheduledTick = false;
    claimAndRun();
  });
}

function claimAndRun(): void {
  if (!started) return;
  const state = useUploadQueueStore.getState();

  while (inFlight.size < FILE_CONCURRENCY) {
    const next = findNextQueued(state.tasks);
    if (!next) return;
    // Immediately move out of 'queued' so the next iteration of this loop
    // (or a concurrent schedule() tick) can't re-pick the same task.
    state.setStatus(next.id, "preparing");
    const promise = runTask(next.id).finally(() => {
      inFlight.delete(next.id);
      progressByTask.delete(next.id);
      // After a task settles, attempt to claim the next queued one. Without
      // this, the dispatcher would idle until some other store mutation
      // wakes the subscriber.
      schedule();
    });
    inFlight.set(next.id, promise);
  }
}

function findNextQueued(
  tasks: Map<string, UploadTaskInternal>,
): UploadTaskInternal | null {
  let earliest: UploadTaskInternal | null = null;
  for (const task of tasks.values()) {
    if (task.status !== "queued") continue;
    if (inFlight.has(task.id)) continue;
    if (!earliest || task.createdAt < earliest.createdAt) {
      earliest = task;
    }
  }
  return earliest;
}

/* ─── task runner ────────────────────────────────────────────── */

async function runTask(id: string): Promise<void> {
  const store = useUploadQueueStore.getState();
  const task = store.tasks.get(id);
  if (!task) return;

  const controller = new AbortController();
  store.setAbortController(id, controller);

  progressByTask.set(id, {
    lastFlushAt: 0,
    partBytes: new Map(),
  });

  // If the user already clicked cancel in the gap between setStatus('preparing')
  // and reaching this line, the store has set status='canceled' and called
  // abort on the controller we just attached. Bail before burning any presign
  // calls — uploadSinglePut/uploadMultipart also defend against this, but
  // checking here saves a round trip.
  const fresh = useUploadQueueStore.getState().tasks.get(id);
  if (!fresh || fresh.status === "canceled") {
    return;
  }

  const input = {
    cid: task.cid,
    bucket: task.bucket,
    key: task.key,
    file: task.file,
  };

  store.setStatus(id, "uploading");

  try {
    if (task.totalBytes < MULTIPART_THRESHOLD_BYTES) {
      await uploadSinglePut(input, {
        signal: controller.signal,
        onProgress: (bytes) => reportSinglePutProgress(id, bytes),
      });
    } else {
      await uploadMultipart(input, {
        signal: controller.signal,
        onUploadIdReady: (uploadId) => {
          useUploadQueueStore.getState().setUploadId(id, uploadId);
        },
        onPartStart: (partNumber) => {
          useUploadQueueStore.getState().setPart(id, partNumber, {
            status: "uploading",
          });
        },
        onPartProgress: (partNumber, bytes) => {
          reportMultipartProgress(id, partNumber, bytes);
        },
        onPartDone: (partNumber, etag) => {
          useUploadQueueStore.getState().setPart(id, partNumber, {
            status: "done",
            etag,
          });
        },
      });
      // The complete call already finished inside uploadMultipart, but the
      // status flicker → 'completing' → 'done' is part of the drawer UX.
      // Set 'completing' just before we mark done so consumers that read on
      // the next tick see the transition.
      useUploadQueueStore.getState().setStatus(id, "completing");
    }

    // Final progress flush so the bar reaches 100% instead of stopping at
    // whatever the last throttled sample was.
    useUploadQueueStore.getState().setProgress(id, task.totalBytes);
    useUploadQueueStore.getState().setStatus(id, "done");
  } catch (err) {
    // Status precedence: an external cancel already wrote 'canceled'. Don't
    // step on the user's click — only mark 'failed' if the current status is
    // still mid-flight. This also covers the case where uploadMultipart
    // surfaces kind='aborted' due to the linked controller firing because
    // of cancel() — the cancel already wrote the correct status.
    const current = useUploadQueueStore.getState().tasks.get(id)?.status;
    if (current === "canceled" || current === "done") return;

    if (err instanceof UploadError && err.kind === "aborted") {
      useUploadQueueStore.getState().setStatus(id, "canceled");
      return;
    }

    const msg = err instanceof Error ? err.message : "Upload failed";
    useUploadQueueStore.getState().setError(id, msg);
  }
}

/* ─── progress throttling ────────────────────────────────────── */

function reportSinglePutProgress(id: string, bytes: number): void {
  const ps = progressByTask.get(id);
  if (!ps) return;
  flushProgressIfDue(id, bytes, ps);
}

function reportMultipartProgress(
  id: string,
  partNumber: number,
  partBytes: number,
): void {
  const ps = progressByTask.get(id);
  if (!ps) return;
  ps.partBytes.set(partNumber, partBytes);
  let total = 0;
  for (const v of ps.partBytes.values()) total += v;
  flushProgressIfDue(id, total, ps);
}

function flushProgressIfDue(
  id: string,
  bytesUploaded: number,
  ps: ProgressState,
): void {
  const now = Date.now();
  // Always flush if this is the very first sample so the bar starts moving
  // immediately rather than after 200ms of "queued"-looking dead time.
  if (
    ps.lastFlushAt !== 0 &&
    now - ps.lastFlushAt < PROGRESS_FLUSH_INTERVAL_MS
  ) {
    return;
  }
  ps.lastFlushAt = now;
  useUploadQueueStore.getState().setProgress(id, bytesUploaded);
}

/* ─── test-only introspection ────────────────────────────────── */

/** EXPORTED FOR TESTS ONLY. Returns a snapshot of the in-flight task ids.
 *  Production code must read from the store instead. */
export function _inFlightCountForTest(): number {
  return inFlight.size;
}

/** EXPORTED FOR TESTS ONLY. Returns the in-flight task ids in a stable
 *  order so the test can assert which tasks were claimed. */
export function _inFlightIdsForTest(): string[] {
  return [...inFlight.keys()].sort();
}

/** EXPORTED FOR TESTS ONLY. Awaits every in-flight worker so a test can
 *  drain the dispatcher before asserting final store state. Yields a few
 *  microtasks first so the initial queueMicrotask(claim) has a chance to
 *  populate inFlight — otherwise a test that calls drain immediately after
 *  startUploadDispatcher would return before any task is claimed. */
export async function _drainForTest(): Promise<void> {
  // Two micro-yields cover: (a) schedule's queueMicrotask, (b) claimAndRun
  // synchronously populating inFlight + the helper's first await.
  await Promise.resolve();
  await Promise.resolve();
  while (inFlight.size > 0 || scheduledTick) {
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()]);
    }
    // After each settle, .finally() schedules another claim pass — yield
    // so that microtask runs and either re-fills inFlight or leaves it
    // empty for the next loop check.
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** EXPORTED FOR TESTS ONLY. Allowed status set the dispatcher will transition
 *  into when claiming. Useful for tests that want to assert the claim mutex
 *  works without reaching into internal types. */
export const _statusesAfterClaim: ReadonlyArray<UploadStatus> = [
  "preparing",
  "uploading",
  "completing",
  "done",
  "failed",
  "canceled",
];
