"use client";

// components/features/upload/upload-queue-provider.tsx
//
// Mount once at the app root. Its only job is to start the upload
// dispatcher (lib/uploads/dispatcher.ts) inside a useEffect so it survives
// across route navigations without remounting.
//
// Why a component and not a top-level module import:
//   * The dispatcher subscribes to the Zustand store. We want that
//     subscription to start only on the client, AFTER hydration, so the
//     SSR pass does not import a browser-only module path. A client
//     component with a useEffect is the cleanest Next.js seam for that.
//   * startUploadDispatcher() is idempotent — React 18 strict-mode runs
//     this effect twice in dev. The module-level guard makes the second
//     call a no-op so we don't end up with two store subscriptions.
//
// This component renders nothing. The drawer UI lives in
// upload-drawer-container.tsx, which is also mounted by Providers.

import { useEffect } from "react";

import { startUploadDispatcher } from "@/lib/uploads/dispatcher";

export function UploadQueueProvider(): null {
  useEffect(() => {
    // No cleanup intentionally: the dispatcher persists for the lifetime
    // of the page so it can pick up tasks queued from any route. The
    // module-level guard means re-running this effect (strict mode, HMR)
    // is harmless.
    startUploadDispatcher();
  }, []);

  return null;
}
