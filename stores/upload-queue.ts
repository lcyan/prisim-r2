// stores/upload-queue.ts
//
// In-memory upload queue. Zustand store that owns the lifecycle of every
// in-flight upload (single-PUT or multipart) initiated by the dashboard.
//
// Why not persist (task brief: "不持久化（关页面=丢失）"):
//   * The actual File handles cannot be revived after a page reload — the
//     browser drops them when the JS heap goes away. Persisting half of the
//     state (status, parts, etags) without the bytes would let the UI lie
//     to the user about resumable uploads. Better to be honest: closing the
//     tab cancels everything in flight, matching what the browser already
//     does at the network layer.
//   * AbortControllers are not serializable, and a serialized 'uploading'
//     task without a controller is unreachable; we would have to invent a
//     synthetic 'orphaned' status. Skipping persistence side-steps the
//     entire foot-gun.
//
// Security invariant (CLAUDE.md §2):
//   Nothing in this store is a credential — `cid` is the connection ULID
//   (a pointer to a server-side row), bucket/key are object metadata. No
//   access keys / secrets ever live here.
//
// Concurrency model:
//   * This store ONLY owns state. The dispatcher (lib/uploads/dispatcher.ts)
//     subscribes, claims queued tasks, and runs the runtime helpers — keeping
//     side-effects out of the store keeps it testable without a fake browser.
//   * Every action returns a new top-level object so Zustand's Object.is
//     comparison wakes up consumers. Map<number, …> for parts is replaced
//     wholesale on each mutation for the same reason.
//
// Speed estimate (used by the upload-drawer chip):
//   * Per-task EMA over a ~200ms sample window. A linear "bytes since first
//     sample" estimate would lurch on backpressure; EMA smooths the spike
//     when a single 10 MB part lands. Alpha 0.4 trades responsiveness for
//     calm — tunable in EMA_ALPHA below.

import { create } from "zustand";
import { ulid } from "ulid";

import type { UploadTask as DrawerUploadTask } from "@/components/features/upload/upload-drawer";

/* ─── public state machine types ─────────────────────────────── */

/** Closed union — adding a new status requires updating dispatcher branches
 *  AND the adapter switch in `toUploadDrawerTask`. */
export type UploadStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "completing"
  | "done"
  | "failed"
  | "canceled";

export type UploadPartStatus = "pending" | "uploading" | "done" | "failed";

export interface UploadPartState {
  /** R2 ETag for this part — stripped of any surrounding quotes before being
   *  stored. Populated only when status is 'done'. */
  etag?: string;
  status: UploadPartStatus;
}

export interface UploadTaskInternal {
  /** ULID. Acts as both the React key and the dispatcher claim id. */
  id: string;
  /** The File handle. Non-serializable (Blob bytes live outside the heap on
   *  some browsers) — one more reason this store does not persist. */
  file: File;
  /** Active connection ULID. */
  cid: string;
  bucket: string;
  /** Full object key the file should land at (caller decides — usually
   *  `${prefix}${file.name}`). */
  key: string;
  status: UploadStatus;
  /** Set after the multipart create call returns. Undefined for single-PUT
   *  uploads. */
  uploadId?: string;
  /** Per-part state. Empty Map for single-PUT uploads. New Map instance on
   *  every mutation so equality checks in selectors fire. */
  parts: Map<number, UploadPartState>;
  /** Bytes successfully transferred so far. Sum of per-part progress for
   *  multipart, or the last xhr.upload.onprogress event for single-PUT. */
  bytesUploaded: number;
  /** Cached File.size. Pinned at enqueue time so the progress bar denominator
   *  is stable even if the dispatcher reads `file.size` later. */
  totalBytes: number;
  /** Human-readable failure reason. Set by `setError`. */
  errorMsg?: string;
  /** Created lazily by the dispatcher when the task claim succeeds. The store
   *  only stores the reference so `cancel()` can fire abort without a round-trip
   *  through the dispatcher. */
  abortController?: AbortController;
  /** Epoch ms. Used by the dispatcher to claim the *oldest* queued task,
   *  which matches user expectation when several files are dropped at once. */
  createdAt: number;

  /** Internal — EMA state for the speed chip. Not exposed via the adapter. */
  _lastSampleTs: number;
  _lastSampleBytes: number;
  _emaSpeed: number;
}

/* ─── store actions surface ──────────────────────────────────── */

interface EnqueueArgs {
  file: File;
  cid: string;
  bucket: string;
  key: string;
}

interface UploadQueueState {
  tasks: Map<string, UploadTaskInternal>;

  /** Adds a new task in 'queued' status and returns its id. The dispatcher
   *  picks it up on the next subscribe tick. */
  enqueue: (args: EnqueueArgs) => string;
  /** Add multiple files in one go, deriving the key per file. Returns the
   *  ids in the same order so the caller can pin a toast / row reference. */
  enqueueMany: (
    cid: string,
    bucket: string,
    files: File[],
    keyForFile: (file: File) => string,
  ) => string[];

  setStatus: (id: string, status: UploadStatus) => void;
  setProgress: (id: string, bytesUploaded: number) => void;
  setUploadId: (id: string, uploadId: string) => void;
  /** Patch one part's state — partial update against the existing entry, or
   *  create a fresh one if missing. */
  setPart: (
    id: string,
    partNumber: number,
    patch: Partial<UploadPartState>,
  ) => void;
  setError: (id: string, msg: string) => void;
  /** Attach the AbortController the dispatcher created. Exposed so `cancel`
   *  can call .abort() without round-tripping through the dispatcher. */
  setAbortController: (id: string, controller: AbortController) => void;

  /** User-initiated cancel. Marks the task 'canceled' and fires .abort() on
   *  the controller if one is attached. The dispatcher observes the status
   *  change and the AbortSignal — either path stops the runtime. */
  cancel: (id: string) => void;
  /** Re-queue a failed task. Resets parts/progress and detaches the old
   *  controller. No-op for non-failed tasks (the user would otherwise be
   *  able to "retry" a successful upload, which would duplicate it). */
  retry: (id: string) => void;

  /** Drop every task in 'done' status. Used by the drawer's "Clear completed". */
  removeDone: () => void;
  /** Drop a single task by id. Used by the drawer's row "Dismiss" button
   *  for canceled/failed rows. Refuses in-flight tasks to avoid orphaning
   *  the dispatcher's promise reference. */
  removeOne: (id: string) => void;
}

/* ─── internals ──────────────────────────────────────────────── */

/** Smoothing factor for the per-task EMA. Larger = more reactive but jumpier.
 *  0.4 keeps the chip readable when a 10 MB part lands all at once. */
const EMA_ALPHA = 0.4;

/** Floor for sample interval so an early progress event (e.g. xhr fires
 *  twice within the same animation frame) doesn't divide-by-near-zero. */
const MIN_SAMPLE_INTERVAL_MS = 50;

/** Status values from which the dispatcher hasn't yet started doing work
 *  the user can't undo by hand. Used by `removeOne` to refuse to drop a row
 *  that the dispatcher is still iterating over. */
const TERMINAL_STATUSES = new Set<UploadStatus>(["done", "failed", "canceled"]);

function makeInitialTask(args: EnqueueArgs): UploadTaskInternal {
  const now = Date.now();
  return {
    id: ulid(),
    file: args.file,
    cid: args.cid,
    bucket: args.bucket,
    key: args.key,
    status: "queued",
    parts: new Map(),
    bytesUploaded: 0,
    totalBytes: args.file.size,
    createdAt: now,
    _lastSampleTs: now,
    _lastSampleBytes: 0,
    _emaSpeed: 0,
  };
}

/** Replace one task in the tasks Map, returning a new top-level Map so the
 *  store fires a change notification. Returns the existing Map untouched if
 *  the id is unknown — callers should treat that as a no-op. */
function patchTask(
  tasks: Map<string, UploadTaskInternal>,
  id: string,
  patch: (t: UploadTaskInternal) => UploadTaskInternal,
): Map<string, UploadTaskInternal> {
  const existing = tasks.get(id);
  if (!existing) return tasks;
  const next = new Map(tasks);
  next.set(id, patch(existing));
  return next;
}

/* ─── store factory ──────────────────────────────────────────── */

export const useUploadQueueStore = create<UploadQueueState>()((set) => ({
  tasks: new Map(),

  enqueue: (args) => {
    const task = makeInitialTask(args);
    set((state) => {
      const next = new Map(state.tasks);
      next.set(task.id, task);
      return { tasks: next };
    });
    return task.id;
  },

  enqueueMany: (cid, bucket, files, keyForFile) => {
    const ids: string[] = [];
    set((state) => {
      const next = new Map(state.tasks);
      for (const file of files) {
        const task = makeInitialTask({
          file,
          cid,
          bucket,
          key: keyForFile(file),
        });
        next.set(task.id, task);
        ids.push(task.id);
      }
      return { tasks: next };
    });
    return ids;
  },

  setStatus: (id, status) =>
    set((state) => ({
      tasks: patchTask(state.tasks, id, (t) => ({ ...t, status })),
    })),

  setProgress: (id, bytesUploaded) =>
    set((state) => {
      const existing = state.tasks.get(id);
      if (!existing) return {};
      // EMA over instantaneous bytes/sec since the last sample. If samples
      // arrive faster than MIN_SAMPLE_INTERVAL_MS we hold the previous EMA —
      // the next sample after the floor expires will use a wider window.
      const now = Date.now();
      const dt = now - existing._lastSampleTs;
      let nextEma = existing._emaSpeed;
      let nextSampleTs = existing._lastSampleTs;
      let nextSampleBytes = existing._lastSampleBytes;
      if (dt >= MIN_SAMPLE_INTERVAL_MS) {
        const deltaBytes = Math.max(
          0,
          bytesUploaded - existing._lastSampleBytes,
        );
        const instant = (deltaBytes / dt) * 1000;
        nextEma =
          existing._emaSpeed === 0
            ? instant
            : EMA_ALPHA * instant + (1 - EMA_ALPHA) * existing._emaSpeed;
        nextSampleTs = now;
        nextSampleBytes = bytesUploaded;
      }
      const tasks = patchTask(state.tasks, id, (t) => ({
        ...t,
        bytesUploaded,
        _lastSampleTs: nextSampleTs,
        _lastSampleBytes: nextSampleBytes,
        _emaSpeed: nextEma,
      }));
      return { tasks };
    }),

  setUploadId: (id, uploadId) =>
    set((state) => ({
      tasks: patchTask(state.tasks, id, (t) => ({ ...t, uploadId })),
    })),

  setPart: (id, partNumber, patch) =>
    set((state) => ({
      tasks: patchTask(state.tasks, id, (t) => {
        const existing = t.parts.get(partNumber) ?? {
          status: "pending" as const,
        };
        const merged: UploadPartState = { ...existing, ...patch };
        const parts = new Map(t.parts);
        parts.set(partNumber, merged);
        return { ...t, parts };
      }),
    })),

  setError: (id, msg) =>
    set((state) => ({
      tasks: patchTask(state.tasks, id, (t) => ({
        ...t,
        status: "failed",
        errorMsg: msg,
      })),
    })),

  setAbortController: (id, controller) =>
    set((state) => ({
      tasks: patchTask(state.tasks, id, (t) => ({
        ...t,
        abortController: controller,
      })),
    })),

  cancel: (id) =>
    set((state) => {
      const existing = state.tasks.get(id);
      if (!existing) return {};
      // Idempotent — calling cancel on a terminal task is a no-op so a
      // double-click on the X button doesn't flip 'done' back to 'canceled'.
      if (TERMINAL_STATUSES.has(existing.status)) return {};
      // Side effect inside the setter is intentional: we want the abort()
      // to happen exactly once even under React 18 strict-mode double-invoke
      // because Zustand only calls the updater once per actual set().
      existing.abortController?.abort();
      const tasks = patchTask(state.tasks, id, (t) => ({
        ...t,
        status: "canceled" as const,
      }));
      return { tasks };
    }),

  retry: (id) =>
    set((state) => {
      const existing = state.tasks.get(id);
      if (!existing) return {};
      if (existing.status !== "failed" && existing.status !== "canceled") {
        return {};
      }
      const now = Date.now();
      const tasks = patchTask(state.tasks, id, (t) => ({
        ...t,
        status: "queued" as const,
        parts: new Map(),
        bytesUploaded: 0,
        uploadId: undefined,
        errorMsg: undefined,
        abortController: undefined,
        // Reset EMA so the speed chip doesn't show stale numbers from the
        // previous attempt while the new presign call is in flight.
        _lastSampleTs: now,
        _lastSampleBytes: 0,
        _emaSpeed: 0,
        // Re-stamp createdAt so a manual retry goes to the back of the
        // queue rather than starving newer drops.
        createdAt: now,
      }));
      return { tasks };
    }),

  removeDone: () =>
    set((state) => {
      const next = new Map<string, UploadTaskInternal>();
      for (const [id, task] of state.tasks) {
        if (task.status !== "done") next.set(id, task);
      }
      return { tasks: next };
    }),

  removeOne: (id) =>
    set((state) => {
      const existing = state.tasks.get(id);
      if (!existing) return {};
      if (!TERMINAL_STATUSES.has(existing.status)) {
        // Refusing the drop avoids orphaning the in-flight promise in the
        // dispatcher's tracking map. The caller should cancel() first.
        return {};
      }
      const next = new Map(state.tasks);
      next.delete(id);
      return { tasks: next };
    }),
}));

/* ─── selectors / adapters ───────────────────────────────────── */

/** Convenience hook so a header banner doesn't re-render every time the
 *  parts Map mutates internally. Counts total active+queued tasks. */
export function useUploadQueueCount(): number {
  return useUploadQueueStore((s) => s.tasks.size);
}

/** Subscribe to the snapshot the drawer should render — ordered oldest first
 *  so the rows don't jitter on every status change. Returns the SAME array
 *  identity between renders when nothing changed (via Zustand's default
 *  Object.is on the Map — adapter happens outside the selector). */
export function selectTasksOrdered(
  state: UploadQueueState,
): UploadTaskInternal[] {
  return orderTasks(state.tasks);
}

/** Pure helper extracted from the selector so the drawer container can call
 *  it with just the tasks Map (which is what its useMemo deps shrink to)
 *  without synthesizing a fake state object. */
export function orderTasks(
  tasks: Map<string, UploadTaskInternal>,
): UploadTaskInternal[] {
  const out = [...tasks.values()];
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/** Map the internal model to the public `UploadTask` shape consumed by
 *  `components/features/upload/upload-drawer.tsx`. Filename derived from the
 *  full key's trailing segment for parity with the file-table display. */
export function toUploadDrawerTask(task: UploadTaskInternal): DrawerUploadTask {
  const status =
    // The internal 'preparing' state is invisible to the drawer — the user
    // sees "queued" until bytes start flowing. Avoids a one-frame flash to a
    // status the drawer would render with a 0% progress bar.
    task.status === "preparing" ? "queued" : task.status;
  return {
    id: task.id,
    filename: trailingSegment(task.key) || task.file.name,
    bytes: task.totalBytes,
    uploaded: task.bytesUploaded,
    speed: task._emaSpeed,
    status,
    errorMsg: task.errorMsg,
  };
}

function trailingSegment(key: string): string {
  const trimmed = key.replace(/\/+$/u, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
