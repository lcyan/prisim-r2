"use client";

// components/features/upload/upload-drawer-container.tsx
//
// Stateful container that reads from the upload queue store and renders
// the presentational <UploadDrawer />. Kept separate from upload-drawer.tsx
// so the drawer remains a pure component testable without Zustand.
//
// Subscription strategy:
//   * The container subscribes to `tasks` (the Map identity), then derives
//     an array via `useMemo` so React only re-renders the drawer when the
//     Map actually mutated. Without the memo, every progress flush would
//     create a fresh array even when the count and statuses are unchanged
//     — fine for correctness, wasteful for re-render volume.
//   * Actions are read individually via selectors so the container's deps
//     stay shallow.

import { useMemo } from "react";

import { UploadDrawer } from "./upload-drawer";
import {
  orderTasks,
  toUploadDrawerTask,
  useUploadQueueStore,
} from "@/stores/upload-queue";

export function UploadDrawerContainer() {
  const tasksMap = useUploadQueueStore((s) => s.tasks);
  const cancel = useUploadQueueStore((s) => s.cancel);
  const retry = useUploadQueueStore((s) => s.retry);
  const removeOne = useUploadQueueStore((s) => s.removeOne);
  const removeDone = useUploadQueueStore((s) => s.removeDone);

  // Derive ordered, drawer-shaped tasks once per tasks Map mutation. The
  // selector path takes the Map and produces a fresh array — React only
  // re-renders the drawer when the Map identity changes (one per store set).
  const drawerTasks = useMemo(
    () => orderTasks(tasksMap).map(toUploadDrawerTask),
    [tasksMap],
  );

  return (
    <UploadDrawer
      tasks={drawerTasks}
      onCancel={cancel}
      onRetry={retry}
      onDismiss={removeOne}
      onClearDone={removeDone}
    />
  );
}
