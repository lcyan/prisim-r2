"use client";

import { type ReactNode, useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import { cn, formatBytes, formatSpeed } from "@/lib/utils";

const T = {
  region: "上传队列",
  uploads: "上传",
  active: (n: number) => `${n} 个进行中`,
  queued: (n: number) => `${n} 个等待中`,
  failed: (n: number) => `${n} 个失败`,
  done: (n: number) => `${n} 个完成`,
  clearCompleted: "清除已完成",
  cancelLabel: "取消上传",
  retryLabel: "重试上传",
  dismissLabel: "关闭",
  statQueued: "等待中",
  statFinalizing: "正在完成",
  statComplete: "已完成",
  statFailed: "失败",
  statCanceled: "已取消",
} as const;

/**
 * UploadDrawer — fixed bottom-right tray that shows the in-flight upload queue.
 * Reads from the `useUploadQueue` Zustand store (defined in stores/upload-queue.ts,
 * see Task 17). This file is the presentational shell only — it receives tasks
 * and action callbacks. No network calls happen here.
 *
 * Signature visual: amber pulsing dot when uploads are active. Slim 2px progress bar.
 */

export type UploadStatus =
  | "queued"
  | "uploading"
  | "completing"
  | "done"
  | "failed"
  | "canceled";

export interface UploadTask {
  id: string;
  filename: string;
  bytes: number;
  /** bytes uploaded so far */
  uploaded: number;
  /** instantaneous speed in bytes/second */
  speed: number;
  status: UploadStatus;
  errorMsg?: string;
}

interface UploadDrawerProps {
  tasks: UploadTask[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  onClearDone: () => void;
  /** Optional override: default is `tasks.length > 0` */
  visible?: boolean;
}

export function UploadDrawer({
  tasks,
  onCancel,
  onRetry,
  onDismiss,
  onClearDone,
  visible,
}: UploadDrawerProps) {
  const [expanded, setExpanded] = useState(true);

  const shouldShow = visible ?? tasks.length > 0;
  if (!shouldShow) return null;

  const counts = {
    uploading: tasks.filter(
      (t) => t.status === "uploading" || t.status === "completing",
    ).length,
    queued: tasks.filter((t) => t.status === "queued").length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  };

  return (
    <aside
      role="region"
      aria-label={T.region}
      className="fixed right-4 bottom-4 z-50 w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card"
      style={{ boxShadow: "var(--shadow-lg)" }}
    >
      <DrawerHeader
        counts={counts}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />

      {expanded ? (
        <>
          <ul className="max-h-[40vh] divide-y divide-border overflow-auto">
            {tasks.map((task) => (
              <li key={task.id}>
                <UploadRow
                  task={task}
                  onCancel={onCancel}
                  onRetry={onRetry}
                  onDismiss={onDismiss}
                />
              </li>
            ))}
          </ul>

          {counts.done > 0 ? (
            <div className="flex items-center justify-end border-t border-border bg-secondary/30 px-3.5 py-2">
              <button
                type="button"
                onClick={onClearDone}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {T.clearCompleted}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

/* ──────────────────────────────────────────────────────────── */

function DrawerHeader({
  counts,
  expanded,
  onToggle,
}: {
  counts: { uploading: number; queued: number; done: number; failed: number };
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center justify-between gap-3 border-b border-border bg-secondary/50 px-3.5 py-2.5 text-left transition-colors hover:bg-secondary"
    >
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground">{T.uploads}</p>
        <div className="flex items-center gap-2.5 text-xs">
          {counts.uploading > 0 ? (
            <StatChip tone="active">
              <PulseDot />
              {T.active(counts.uploading)}
            </StatChip>
          ) : null}
          {counts.queued > 0 ? (
            <StatChip tone="muted">{T.queued(counts.queued)}</StatChip>
          ) : null}
          {counts.failed > 0 ? (
            <StatChip tone="destructive">{T.failed(counts.failed)}</StatChip>
          ) : null}
          {counts.done > 0 && counts.uploading === 0 && counts.queued === 0 ? (
            <StatChip tone="success">{T.done(counts.done)}</StatChip>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      ) : (
        <ChevronUp className="h-4 w-4 text-muted-foreground" />
      )}
    </button>
  );
}

function StatChip({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "active" | "muted" | "success" | "destructive";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        tone === "active" && "text-foreground",
        tone === "muted" && "text-muted-foreground",
        tone === "success" && "text-success",
        tone === "destructive" && "text-destructive",
      )}
    >
      {children}
    </span>
  );
}

function PulseDot() {
  return (
    <span className="relative inline-block h-1.5 w-1.5">
      <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60" />
      <span className="absolute inset-0 rounded-full bg-primary" />
    </span>
  );
}

/* ──────────────────────────────────────────────────────────── */

function UploadRow({
  task,
  onCancel,
  onRetry,
  onDismiss,
}: {
  task: UploadTask;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const percent =
    task.bytes > 0 ? Math.min(100, (task.uploaded / task.bytes) * 100) : 0;

  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p
            className="truncate text-xs font-medium text-foreground"
            title={task.filename}
          >
            {task.filename}
          </p>
          <ProgressLabel status={task.status} percent={percent} />
        </div>

        <div className="relative mt-1.5 h-[2px] w-full overflow-hidden rounded-full bg-border">
          <div
            className={cn(
              "absolute inset-y-0 left-0 transition-[width] duration-300 ease-out",
              task.status === "failed" && "bg-destructive",
              task.status === "done" && "bg-success",
              (task.status === "uploading" || task.status === "completing") &&
                "bg-primary",
              task.status === "queued" && "bg-muted-foreground/40",
              task.status === "canceled" && "bg-muted-foreground/30",
            )}
            style={{ width: `${task.status === "done" ? 100 : percent}%` }}
          />
        </div>

        <p
          className={cn(
            "mt-1 text-xs tabular-nums",
            statusToneClass(task.status),
          )}
        >
          {statusLabel(task)}
        </p>
      </div>

      <RowControl
        task={task}
        onCancel={onCancel}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />
    </div>
  );
}

function statusToneClass(status: UploadStatus): string {
  switch (status) {
    case "queued":
      return "text-muted-foreground";
    case "uploading":
      return "text-foreground";
    case "completing":
      return "text-primary";
    case "done":
      return "text-success";
    case "failed":
      return "text-destructive";
    case "canceled":
      return "text-muted-foreground";
  }
}

function statusLabel(task: UploadTask): string {
  switch (task.status) {
    case "queued":
      return T.statQueued;
    case "uploading":
      return `${formatSpeed(task.speed)} · ${formatBytes(task.uploaded)} / ${formatBytes(task.bytes)}`;
    case "completing":
      return T.statFinalizing;
    case "done":
      return `${formatBytes(task.bytes)} · ${T.statComplete}`;
    case "failed":
      return task.errorMsg ?? T.statFailed;
    case "canceled":
      return T.statCanceled;
  }
}

function ProgressLabel({
  status,
  percent,
}: {
  status: UploadStatus;
  percent: number;
}) {
  const base = "font-mono text-[10px] tabular-nums";
  switch (status) {
    case "done":
      return <span className={cn(base, "text-success")}>100%</span>;
    case "failed":
      return <span className={cn(base, "text-destructive")}>错</span>;
    case "canceled":
      return <span className={cn(base, "text-muted-foreground")}>—</span>;
    case "queued":
      return <span className={cn(base, "text-muted-foreground")}>⋯</span>;
    default:
      return (
        <span className={cn(base, "text-muted-foreground")}>
          {Math.floor(percent)}%
        </span>
      );
  }
}

function RowControl({
  task,
  onCancel,
  onRetry,
  onDismiss,
}: {
  task: UploadTask;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const inFlight =
    task.status === "uploading" ||
    task.status === "queued" ||
    task.status === "completing";

  if (inFlight) {
    return (
      <ControlButton
        onClick={() => onCancel(task.id)}
        label={T.cancelLabel}
        destructive
      >
        <X className="h-3.5 w-3.5" />
      </ControlButton>
    );
  }
  if (task.status === "failed") {
    return (
      <ControlButton onClick={() => onRetry(task.id)} label={T.retryLabel}>
        <RotateCcw className="h-3.5 w-3.5" />
      </ControlButton>
    );
  }
  return (
    <ControlButton onClick={() => onDismiss(task.id)} label={T.dismissLabel}>
      <X className="h-3.5 w-3.5" />
    </ControlButton>
  );
}

function ControlButton({
  children,
  label,
  onClick,
  destructive = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors",
        destructive
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
