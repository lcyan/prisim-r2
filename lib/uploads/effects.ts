// lib/uploads/effects.ts
//
// Browser-side side-effects that watch the upload queue store. Live in
// their own module so the Vitest unit suite can drive them with a mocked
// `window` and fake timers, and so that upload-queue-provider.tsx stays
// a thin "mount once" component.
//
// Three effects live here:
//
//   1. autoRemoveDone — when a task transitions to `done`, schedule it for
//      removal 5 s later. The drawer renders `done` rows with a static
//      success state, and we don't want a long-running session to grow a
//      multi-page list of finished uploads. Retried/failed tasks are
//      *not* affected. If the user manually dismisses or clears a `done`
//      row before the timer fires, the pending timeout is cancelled to
//      avoid a `removeOne` call on a now-missing id.
//
//   2. beforeUnloadGuard — sets `window.onbeforeunload` whenever any task
//      is in flight so the browser prompts before navigating away. Clears
//      the handler the moment the queue drains. Uses addEventListener +
//      removeEventListener rather than assigning to window.onbeforeunload
//      directly so we cooperate with anything else the app might wire up.
//
//   3. invalidateOnDone — when a task transitions to `done`, invalidate
//      the React Query cache key the file table uses so the listing
//      re-fetches. The provider closes over a QueryClient and passes a
//      callback so this module stays free of `@tanstack/react-query`.
//
// All effects are no-ops on the server. They return a `stop()` function
// for tests; production wiring (UploadQueueProvider) does not call stop.

import {
  useUploadQueueStore,
  type UploadStatus,
  type UploadTaskInternal,
} from "@/stores/upload-queue";
import { objectsQueryKey } from "@/hooks/use-objects";

/** Statuses the user perceives as "still working." Used by both effects:
 *  `beforeUnloadGuard` triggers when at least one task is in this set,
 *  and `autoRemoveDone` cancels a pending timer if a task moves *back*
 *  into this set via retry. */
const IN_FLIGHT_STATUSES: ReadonlySet<UploadStatus> = new Set([
  "queued",
  "preparing",
  "uploading",
  "completing",
]);

/** How long a `done` row stays visible before auto-removal. 5 s matches
 *  the PRD ("done 状态 fade out 5 秒后移除") and is long enough that a
 *  user glancing at the drawer can confirm the upload succeeded. */
export const DONE_AUTO_REMOVE_MS = 5_000;

/* ─── 1. Auto-remove done tasks after a delay ──────────────────── */

/** Start watching the store for newly-done tasks and schedule them for
 *  removal. Returns a cleanup function that cancels any pending timers
 *  and unsubscribes — exported for tests. Production code calls this
 *  once on mount and ignores the cleanup. */
export function startAutoRemoveDone(opts?: {
  /** Override for tests. Defaults to global setTimeout. */
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Override for tests. Defaults to global clearTimeout. */
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Override the 5 s delay (tests use 0 to fire synchronously). */
  delayMs?: number;
}): () => void {
  const scheduleTimeout = opts?.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = opts?.clearTimeout ?? globalThis.clearTimeout;
  const delay = opts?.delayMs ?? DONE_AUTO_REMOVE_MS;

  // Map<taskId, timer-handle>. Tracked so a transition out of `done`
  // (manual dismiss, parent clear, or retry) cancels the scheduled
  // removal — without this, the removeOne would be a no-op for a
  // missing id but it would still leak a timer until it fired.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelOne(id: string) {
    const handle = pending.get(id);
    if (handle !== undefined) {
      cancelTimeout(handle);
      pending.delete(id);
    }
  }

  // Subscribe to the full store and diff against the previous snapshot.
  // Zustand v5's selector-based subscribe would require us to project
  // a value; this is simpler and reads `tasks` directly each tick.
  //
  // Seed `previous` with an empty Map (NOT the current snapshot) so the
  // first handleChange() pass treats every existing task as a fresh
  // transition. That way, mounting the effect on a page that already
  // has a `done` row still schedules a removal — without this, the
  // initial pass would see prevStatus === task.status for everything
  // and short-circuit.
  let previous: Map<string, UploadTaskInternal> = new Map();

  const handleChange = () => {
    const current = useUploadQueueStore.getState().tasks;

    // For each task in the current snapshot:
    //  * if it's `done` and we haven't scheduled it → schedule
    //  * if it transitioned *out* of `done` → cancel any pending timer
    for (const [id, task] of current) {
      const prevTask = previous.get(id);
      const prevStatus = prevTask?.status;
      if (task.status === "done") {
        if (prevStatus !== "done" && !pending.has(id)) {
          const handle = scheduleTimeout(() => {
            pending.delete(id);
            // Re-check before removing — the user may have already
            // clicked Dismiss between schedule and fire. removeOne
            // is idempotent so this is mostly defensive.
            const stillDone =
              useUploadQueueStore.getState().tasks.get(id)?.status === "done";
            if (stillDone) {
              useUploadQueueStore.getState().removeOne(id);
            }
          }, delay);
          pending.set(id, handle);
        }
      } else if (prevStatus === "done") {
        // Retried after being marked done (rare but possible if the
        // user clicks retry on a "done" row that we expose in the
        // future). Cancel the removal timer either way.
        cancelOne(id);
      }
    }

    // Tasks present in previous but absent from current: removal already
    // happened (e.g. clearDone). Drop any pending timer to avoid leaking
    // a handle. Iterating a Map during another's iteration is fine
    // because we don't mutate the one we're iterating.
    for (const id of pending.keys()) {
      if (!current.has(id)) {
        cancelOne(id);
      }
    }

    previous = current;
  };

  // Initial pass so the effect picks up a task that's already `done`
  // when it starts (e.g. hot reload during dev).
  handleChange();
  const unsubscribe = useUploadQueueStore.subscribe(handleChange);

  return () => {
    unsubscribe();
    for (const handle of pending.values()) cancelTimeout(handle);
    pending.clear();
  };
}

/* ─── 2. beforeunload guard while uploads are in flight ────────── */

/** Window contract surface we need. Defined as an interface so tests
 *  can pass a stub object instead of patching the real `window`. */
export interface BeforeUnloadHost {
  addEventListener: (
    type: "beforeunload",
    listener: (e: Event) => void,
  ) => void;
  removeEventListener: (
    type: "beforeunload",
    listener: (e: Event) => void,
  ) => void;
}

/** Register a `beforeunload` listener whenever any task is in flight.
 *  Returns a cleanup function that removes the listener + unsubscribes.
 *  The listener itself just calls preventDefault and sets returnValue —
 *  modern browsers ignore custom strings, but Safari still needs the
 *  truthy returnValue to show the confirm prompt. */
export function startBeforeUnloadGuard(opts?: {
  /** Override the host for tests. Defaults to `window` when present. */
  host?: BeforeUnloadHost;
}): () => void {
  const host = opts?.host ?? getWindowHost();
  if (!host) {
    // SSR / non-browser environment — return a no-op cleanup.
    return () => {};
  }

  let listenerAttached = false;

  const listener = (event: Event) => {
    // Required pattern for cross-browser prompt support: preventDefault
    // for Chrome/Firefox, returnValue assignment for older Safari.
    // `Event.returnValue` is typed as `boolean` in lib.dom but
    // BeforeUnloadEvent narrows it to `string`; cast through unknown so
    // strict TS lets us touch the property without re-declaring it.
    event.preventDefault();
    (event as unknown as { returnValue: string }).returnValue = "";
  };

  const handleChange = () => {
    const tasks = useUploadQueueStore.getState().tasks;
    let hasInFlight = false;
    for (const task of tasks.values()) {
      if (IN_FLIGHT_STATUSES.has(task.status)) {
        hasInFlight = true;
        break;
      }
    }

    if (hasInFlight && !listenerAttached) {
      host.addEventListener("beforeunload", listener);
      listenerAttached = true;
    } else if (!hasInFlight && listenerAttached) {
      host.removeEventListener("beforeunload", listener);
      listenerAttached = false;
    }
  };

  handleChange();
  const unsubscribe = useUploadQueueStore.subscribe(handleChange);

  return () => {
    unsubscribe();
    if (listenerAttached) {
      host.removeEventListener("beforeunload", listener);
      listenerAttached = false;
    }
  };
}

function getWindowHost(): BeforeUnloadHost | null {
  if (typeof window === "undefined") return null;
  return window;
}

/* ─── 3. Invalidate the file listing when an upload completes ────── */

/** Watch the queue for tasks transitioning into `done` and invalidate the
 *  TanStack Query cache for every (connection, bucket, ancestor-prefix)
 *  the upload landed under — the file's own prefix AND every parent up
 *  to the root. Without this, dropping a folder `logo/` onto the root
 *  view invalidates `["objects", cid, bucket, "logo/"]` but the page
 *  the user is looking at is keyed `["objects", cid, bucket, ""]`, so
 *  the new `logo/` row never shows up until manual refresh.
 *
 *  The callback is `invalidate(queryKey)` rather than a `QueryClient`
 *  instance so this module stays free of `@tanstack/react-query` —
 *  `UploadQueueProvider` closes over its provider's QueryClient and passes
 *  a thin wrapper. Each task fires `invalidate` once per ancestor prefix
 *  exactly once: subsequent ticks observing the same `done` status are
 *  deduped against the previous snapshot, matching the contract of the
 *  auto-remove effect above. */
export function startInvalidateOnDone(
  invalidate: (queryKey: readonly unknown[]) => void,
): () => void {
  // Seeded empty (NOT the current snapshot) so a fresh mount sitting on top
  // of an already-`done` task — possible under React 18 StrictMode's
  // double-invoke, or if the user navigates back into a page mid-upload-
  // completion — still fires one invalidate. Without this seed, the first
  // pass would see prevStatus === "done" and skip.
  let previous: Map<string, UploadTaskInternal> = new Map();

  const handleChange = () => {
    const current = useUploadQueueStore.getState().tasks;
    for (const [id, task] of current) {
      const prevStatus = previous.get(id)?.status;
      if (task.status === "done" && prevStatus !== "done") {
        for (const prefix of ancestorPrefixes(prefixOfKey(task.key))) {
          invalidate(objectsQueryKey(task.cid, task.bucket, prefix));
        }
      }
    }
    previous = current;
  };

  handleChange();
  const unsubscribe = useUploadQueueStore.subscribe(handleChange);

  return () => {
    unsubscribe();
  };
}

/** Pull the directory portion from a full object key. `foo/bar/baz.txt`
 *  → `foo/bar/`; `top.txt` → ``. Matches the prefix the bucket-browser
 *  page passes to `useObjects`, so the cache key the effect invalidates
 *  is the same one the listing query subscribes to. */
function prefixOfKey(key: string): string {
  const idx = key.lastIndexOf("/");
  return idx >= 0 ? key.slice(0, idx + 1) : "";
}

/** Expand a prefix into itself plus every ancestor up to root. `foo/bar/`
 *  → `["foo/bar/", "foo/", ""]`; `""` → `[""]`. The bucket browser only
 *  subscribes to ONE prefix at a time, but we don't know which one from
 *  here, so we invalidate the whole chain — only the active listing
 *  refetches (TanStack Query's default refetchType="active"); inactive
 *  ancestor cache entries are just marked stale, no extra network. */
function ancestorPrefixes(prefix: string): readonly string[] {
  if (prefix === "") return [""];
  const result: string[] = [prefix];
  // Walk: "foo/bar/" → "foo/" → "" by trimming the last segment each step.
  // slice(0, -1) drops the trailing "/", lastIndexOf("/") gives the parent
  // boundary, +1 keeps the trailing slash on the parent.
  let cursor = prefix.slice(0, -1);
  while (cursor.length > 0) {
    const idx = cursor.lastIndexOf("/");
    if (idx < 0) break;
    result.push(cursor.slice(0, idx + 1));
    cursor = cursor.slice(0, idx);
  }
  result.push("");
  return result;
}
