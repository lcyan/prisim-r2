"use client";

// components/features/upload/upload-queue-provider.tsx
//
// Mount once at the app root. Wires up the three browser-only effects
// that own the upload subsystem's lifecycle:
//
//   1. startUploadDispatcher() — the worker loop that picks queued
//      tasks and runs them (lib/uploads/dispatcher.ts).
//   2. startAutoRemoveDone() — schedules `done` rows for removal 5 s
//      after they finish (lib/uploads/effects.ts).
//   3. startBeforeUnloadGuard() — prompts the user before closing the
//      tab while uploads are still in flight (lib/uploads/effects.ts).
//
// Why a component and not a top-level module import:
//   * Each effect subscribes to the Zustand store and (for the unload
//     guard) the window object. We want all of that to start only on the
//     client, AFTER hydration, so the SSR pass does not import browser-
//     only paths. A client component with a useEffect is the cleanest
//     Next.js seam for that.
//   * All three start functions are idempotent / cleanup-safe — React 18
//     strict-mode runs this effect twice in dev. Module-level guards in
//     the dispatcher + symmetric cleanup in the effect helpers keep that
//     harmless.
//
// This component renders nothing. The drawer UI lives in
// upload-drawer-container.tsx, which is also mounted by Providers.

import { useEffect } from "react";

import { startUploadDispatcher } from "@/lib/uploads/dispatcher";
import {
  startAutoRemoveDone,
  startBeforeUnloadGuard,
} from "@/lib/uploads/effects";

export function UploadQueueProvider(): null {
  useEffect(() => {
    // Dispatcher: guarded internally, no cleanup needed in production —
    // we want the worker loop to outlive the React tree if a navigation
    // tears the providers down for any reason. Cleanup is exposed for
    // tests only.
    startUploadDispatcher();

    // The two effect helpers DO return useful cleanups (event listeners
    // and timer handles); attach them to the useEffect cleanup so React
    // doesn't accumulate duplicate subscribers across HMR/strict-mode
    // re-runs.
    const stopAutoRemove = startAutoRemoveDone();
    const stopUnloadGuard = startBeforeUnloadGuard();
    return () => {
      stopAutoRemove();
      stopUnloadGuard();
    };
  }, []);

  return null;
}
