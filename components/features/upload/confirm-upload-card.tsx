"use client";

// components/features/upload/confirm-upload-card.tsx
//
// Confirm-upload modal that sits between every dropzone entry (drag/drop,
// file picker, folder picker) and the upload-queue dispatcher. Shows a
// preview of what is about to be uploaded so the user can:
//   * change the target prefix (free-text input OR popover-style PrefixPicker)
//   * toggle "include hidden files"
//   * see which files would overwrite existing R2 objects
//   * cancel everything, or commit
//
// The card is mounted unconditionally by the layout shell; it returns
// `null` when the staging store is closed. Commit fires the parent's
// `onCommit({ accepted, targetPrefix })` and then `reset()`s the staging
// store so the parent does NOT have to re-implement that bookkeeping —
// this component does NOT enqueue uploads itself. The parent owns the
// dispatcher contract; the modal owns its own visibility lifecycle.
//
// Why a separate "staging" store + "commit" callback (vs. wiring straight
// into upload-queue):
//   * The preview must be cheap to discard: cancel === reset(), no leaked
//     QueuedFile refs in the queue store.
//   * Conflict detection runs once, against the user's current target
//     prefix — different from the upload-queue's per-task state machine.
//   * Tests can drive the visible state via .open({...}) without booting
//     the dispatcher at all (see tests/unit/components/confirm-upload-card.test.tsx).

import { useMemo, useState } from "react";

import { PrefixPicker } from "@/components/features/upload/prefix-picker";
import { useUploadConflicts } from "@/hooks/use-upload-conflicts";
import {
  keyForQueuedFile,
  partitionQueuedFiles,
  QueuedFileSkipReason,
  type QueuedFile,
  type QueuedFileSkipReasonValue,
} from "@/lib/uploads/dropzone-utils";
import { formatBytes } from "@/lib/utils";
import { useUploadStagingStore } from "@/stores/upload-staging";

const T = {
  title: "确认上传",
  count: (n: number) => `待上传 ${n} 个文件`,
  totalSize: (s: string) => `共 ${s}`,
  targetLabel: "目标路径",
  targetPlaceholder: "(根目录)",
  pickPath: "▾ 选择",
  includeHidden: "包含隐藏文件",
  conflictBanner: (n: number) => `${n} 个文件会覆盖已有对象`,
  uncheckedDepth:
    "部分目标前缀尚未加载,可能还有未列出的同名对象。继续上传将直接覆盖。",
  previewAccepted: "将要上传",
  previewSkipped: "已忽略",
  moreFiles: (n: number) => `…还有 ${n} 个文件`,
  cancel: "取消",
  commit: "开始上传",
  commitOverwrite: (n: number) => `覆盖 ${n} 个文件并上传`,
  skipReason: (r: QueuedFileSkipReasonValue): string => {
    switch (r) {
      case QueuedFileSkipReason.TooLarge:
        return "超过 5 GB";
      case QueuedFileSkipReason.Empty:
        return "为空";
      case QueuedFileSkipReason.Hidden:
        return "隐藏文件";
      case QueuedFileSkipReason.ParentTraversal:
        return "路径含 ..";
      case QueuedFileSkipReason.KeyTooLong:
        return "键名超过 1024 字节";
    }
  },
} as const;

const PREVIEW_LIMIT = 50;

export interface ConfirmUploadCardProps {
  cid: string;
  bucket: string;
  onCommit: (args: { accepted: QueuedFile[]; targetPrefix: string }) => void;
}

export function ConfirmUploadCard({
  cid,
  bucket,
  onCommit,
}: ConfirmUploadCardProps) {
  // Individual selectors keep re-renders narrow and match house style
  // (see hooks/use-objects.ts comment about per-field selectors).
  const isOpen = useUploadStagingStore((s) => s.isOpen);
  const files = useUploadStagingStore((s) => s.files);
  const targetPrefix = useUploadStagingStore((s) => s.targetPrefix);
  const includeHidden = useUploadStagingStore((s) => s.includeHidden);
  const setTargetPrefix = useUploadStagingStore((s) => s.setTargetPrefix);
  const toggleIncludeHidden = useUploadStagingStore(
    (s) => s.toggleIncludeHidden,
  );
  const reset = useUploadStagingStore((s) => s.reset);

  // The text input binds directly to the store's targetPrefix — there is
  // no local copy. This way the input always reflects the canonical store
  // value (e.g. when the picker writes via `setTargetPrefix`, or when a
  // future `.open(...)` call seeds a different prefix). Per-keystroke
  // writes to the store are fine: nothing else observes partial values
  // until commit, and the partitioner already memos on `targetPrefix`.
  const [pickerOpen, setPickerOpen] = useState(false);

  const partition = useMemo(
    () => partitionQueuedFiles({ files, targetPrefix, includeHidden }),
    [files, targetPrefix, includeHidden],
  );

  const queuedKeys = useMemo(
    () => partition.accepted.map((qf) => keyForQueuedFile(targetPrefix, qf)),
    [partition.accepted, targetPrefix],
  );

  const { conflictKeys, hasUncheckedDepth } = useUploadConflicts({
    cid,
    bucket,
    targetPrefix,
    queuedKeys,
  });

  const totalBytes = useMemo(
    () => partition.accepted.reduce((sum, qf) => sum + qf.file.size, 0),
    [partition.accepted],
  );

  if (!isOpen) return null;

  const conflictCount = conflictKeys.size;
  const acceptedPreview = partition.accepted.slice(0, PREVIEW_LIMIT);
  const acceptedExtra = partition.accepted.length - acceptedPreview.length;
  const skippedPreview = partition.skipped.slice(0, PREVIEW_LIMIT);
  const skippedExtra = partition.skipped.length - skippedPreview.length;

  const handleCommit = () => {
    onCommit({ accepted: partition.accepted, targetPrefix });
    reset();
  };

  const handleCancel = () => {
    reset();
  };

  const handleManualBlur = () => {
    // Normalize: strip a leading slash, ensure a trailing slash (unless
    // empty == root). We don't aggressively reject — the partitioner /
    // presign route is the final gatekeeper.
    let next = targetPrefix.trim();
    if (next.startsWith("/")) next = next.slice(1);
    if (next.length > 0 && !next.endsWith("/")) next = `${next}/`;
    if (next !== targetPrefix) setTargetPrefix(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={T.title}
    >
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-lg">
        {/* Header */}
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-foreground">{T.title}</h2>
          <div className="text-xs text-muted-foreground tabular-nums">
            {T.count(partition.accepted.length)} ·{" "}
            {T.totalSize(formatBytes(totalBytes))}
          </div>
        </div>

        {/* Target prefix */}
        <div className="mb-3">
          <label className="mb-1 block text-xs text-muted-foreground">
            {T.targetLabel}
          </label>
          <div className="relative flex items-center gap-2">
            <input
              type="text"
              value={targetPrefix}
              onChange={(e) => setTargetPrefix(e.target.value)}
              onBlur={handleManualBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              placeholder={T.targetPlaceholder}
              className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className="rounded border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={pickerOpen}
            >
              {T.pickPath}
            </button>
            {pickerOpen && (
              <div className="absolute top-full right-0 z-10 mt-1">
                <PrefixPicker
                  cid={cid}
                  bucket={bucket}
                  initialPrefix={targetPrefix}
                  onSelect={(p) => {
                    setTargetPrefix(p);
                    setPickerOpen(false);
                  }}
                  onCancel={() => setPickerOpen(false)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Include hidden */}
        <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeHidden}
            onChange={() => toggleIncludeHidden()}
            className="size-3.5"
          />
          {T.includeHidden}
        </label>

        {/* Conflict banner */}
        {conflictCount > 0 && (
          <div className="mb-3 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {T.conflictBanner(conflictCount)}
          </div>
        )}
        {hasUncheckedDepth && (
          <div className="mb-3 rounded border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {T.uncheckedDepth}
          </div>
        )}

        {/* Preview list */}
        <details
          open
          className="mb-4 rounded border border-border bg-background"
        >
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            {T.previewAccepted} ({partition.accepted.length}) ·{" "}
            {T.previewSkipped} ({partition.skipped.length})
          </summary>
          <div className="max-h-64 divide-y divide-border overflow-y-auto">
            {acceptedPreview.map((qf, idx) => {
              const key = keyForQueuedFile(targetPrefix, qf);
              const conflict = conflictKeys.has(key);
              return (
                <div
                  key={`a-${idx}-${key}`}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
                >
                  <span className="truncate text-foreground" title={key}>
                    {key}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
                    {conflict && (
                      <span className="text-warning">覆盖</span>
                    )}
                    {formatBytes(qf.file.size)}
                  </span>
                </div>
              );
            })}
            {acceptedExtra > 0 && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground">
                {T.moreFiles(acceptedExtra)}
              </div>
            )}
            {skippedPreview.map((sk, idx) => (
              <div
                key={`s-${idx}-${sk.qf.relativePath}${sk.qf.name}`}
                className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
              >
                <span
                  className="truncate text-muted-foreground line-through"
                  title={`${sk.qf.relativePath}${sk.qf.name}`}
                >
                  {sk.qf.relativePath}
                  {sk.qf.name}
                </span>
                <span className="shrink-0 text-destructive">
                  {T.skipReason(sk.reason)}
                </span>
              </div>
            ))}
            {skippedExtra > 0 && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground">
                {T.moreFiles(skippedExtra)}
              </div>
            )}
          </div>
        </details>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            {T.cancel}
          </button>
          <button
            type="button"
            onClick={handleCommit}
            disabled={partition.accepted.length === 0}
            className={
              conflictCount > 0
                ? "rounded bg-warning px-3 py-1.5 text-sm font-medium text-white hover:bg-warning/90 disabled:opacity-50"
                : "rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            }
          >
            {conflictCount > 0 ? T.commitOverwrite(conflictCount) : T.commit}
          </button>
        </div>
      </div>
    </div>
  );
}
