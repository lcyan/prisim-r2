// stores/upload-staging.ts
//
// Short-lived store for the confirm-upload modal. The dropzone fills it
// with the QueuedFiles a user just dragged/picked, plus a default
// targetPrefix and includeHidden flag. The modal reads and mutates it;
// on cancel / commit the modal calls reset() so the next drop starts
// with a clean slate.
//
// Why a separate store from upload-queue:
//   * Lifecycle differs: upload-queue tasks live until upload completes;
//     staging files live ~one modal session. Merging them would force
//     the queue selector to filter "tentative" tasks and complicate the
//     dispatcher contract.
//   * Security: staging never holds presigned URLs or credentials. The
//     File objects are browser-only and never persisted.

import { create } from "zustand";

import type { QueuedFile } from "@/lib/uploads/dropzone-utils";

interface UploadStagingState {
  files: QueuedFile[];
  /** "" (root) or ends with "/". */
  targetPrefix: string;
  includeHidden: boolean;
  isOpen: boolean;

  /** Open the modal with a set of files. Caller picks the default
   *  targetPrefix (usually the page's current browsing prefix). */
  open: (args: { files: QueuedFile[]; targetPrefix: string }) => void;
  setTargetPrefix: (next: string) => void;
  toggleIncludeHidden: () => void;
  reset: () => void;
}

export const useUploadStagingStore = create<UploadStagingState>()((set) => ({
  files: [],
  targetPrefix: "",
  includeHidden: false,
  isOpen: false,

  open: (args) =>
    set({
      files: args.files,
      targetPrefix: args.targetPrefix,
      isOpen: true,
      // includeHidden intentionally preserved across open() — a user
      // re-opening the modal in one session expects the toggle to stick.
      // reset() is the hard-clear path.
    }),
  setTargetPrefix: (next) => set({ targetPrefix: next }),
  toggleIncludeHidden: () =>
    set((s) => ({ includeHidden: !s.includeHidden })),
  reset: () =>
    set({
      files: [],
      targetPrefix: "",
      includeHidden: false,
      isOpen: false,
    }),
}));
