"use client";

// components/features/upload/dropzone.tsx
//
// Drag-and-drop / click-to-browse upload surface. Wraps an arbitrary
// children region (typically the object browser table) and converts a
// drop event into a batch of upload tasks via the Zustand store. Files
// are routed into the staging store; ConfirmUploadCard takes over the
// user-facing confirm step and the dispatcher only sees committed batches.
//
// Visual model:
//   * The dropzone is invisible until something is dragged over the
//     window — then we light up the wrapper with a dashed primary border
//     and an overlay. We use `pointerEvents: none` on the overlay so the
//     drop event still hits the inner content's handlers.
//   * A small "Drop files…" hint appears in the corner so the user knows
//     the area is interactive even when nothing is being dragged. The
//     Browse button is always visible so keyboard users have a way in.
//
// Why dragenter/dragover/dragleave/drop and not a library:
//   * react-dropzone / react-aria's drop-target adds 5+ KB and would
//     duplicate the file-size validation we already need server-side.
//   * The four-event dance is the only piece of standard HTML5 DnD that
//     matters here. dragenter increments a counter (set state), dragover
//     calls preventDefault to allow drop, dragleave decrements, drop
//     pulls the files and clears state.
//
// Counter pattern for dragleave:
//   Native dragleave fires every time the pointer crosses a child
//   boundary, so a naive `setDragging(false)` flickers on hover. We
//   instead increment on dragenter and decrement on dragleave; only when
//   the counter returns to zero do we hide the overlay. Standard React
//   DnD pattern, called out here so a future cleanup doesn't "simplify"
//   it back into a flicker.

import {
  type DragEvent as ReactDragEvent,
  type ChangeEvent as ReactChangeEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  filesToQueuedFiles,
  readDropAsQueuedFiles,
  type QueuedFile,
} from "@/lib/uploads/dropzone-utils";
import { useUploadStagingStore } from "@/stores/upload-staging";

const T = {
  noConnection: "未选择连接",
  noConnectionHint: "请先在顶部选择一个连接和 bucket。",
  hintLine1: "将文件拖到本页任意位置，或",
  hintBrowse: "浏览",
  hintLine3: "选择文件。",
  hintBrowseFolder: "或上传文件夹",
  maxFileSize: "每个文件最大 5 GB",
  dropTitle: "释放鼠标即可上传到",
  noBucket: "（未选择 bucket）",
} as const;

export interface DropzoneProps {
  /** Active connection ULID. When null the dropzone renders but refuses
   *  to enqueue — the user gets a toast pointing them at the bucket
   *  switcher. */
  cid: string | null;
  /** Active bucket name. Same null semantics as `cid`. */
  bucket: string;
  /** R2-style prefix the files should land at. Expected to be "" (root)
   *  or end with "/" — see `lib/r2/prefix.ts`. */
  prefix: string;
  /** The browseable content the dropzone wraps. Rendered untouched —
   *  the dropzone is a transparent container, not a card. */
  children: ReactNode;
  /** Optional override for the outer wrapper's className. */
  className?: string;
}

export function Dropzone({
  cid,
  bucket,
  prefix,
  children,
  className,
}: DropzoneProps) {
  const openStaging = useUploadStagingStore((s) => s.open);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputId = useId();
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // dragenter/dragleave fire on every child boundary crossing. Using a
  // ref + state counter rather than a single boolean avoids the visible
  // flicker when the pointer crosses a row in the underlying table.
  const dragCounterRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const ready = Boolean(cid && bucket);

  const handleFiles = useCallback(
    (queued: QueuedFile[]) => {
      if (queued.length === 0) return;
      if (!ready || !cid) {
        toast.error(T.noConnection, {
          description: T.noConnectionHint,
        });
        return;
      }
      openStaging({ files: queued, targetPrefix: prefix });
    },
    [ready, cid, prefix, openStaging],
  );

  /* ─── drag handlers ─────────────────────────────────────────── */

  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      // Reject non-file drags so dragging text from another tab doesn't
      // light up the overlay. DataTransfer.types is a DOMStringList in
      // some browsers and an array in others; `Array.from` handles both.
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setIsDragging(true);
    },
    [],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      // Required to allow drop — without preventDefault here the drop
      // event never fires.
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      // Mark the drop effect so the OS shows a copy cursor. Some browsers
      // (Safari) keep the "not allowed" cursor without this.
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDragging(false);
    },
    [],
  );

  const handleDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const dt = event.dataTransfer;
      // Use DataTransferItem.webkitGetAsEntry when present (lets us walk
      // a dropped folder); fall back to flat files for older browsers.
      const supportsEntries =
        dt.items &&
        dt.items.length > 0 &&
        typeof (
          dt.items[0] as DataTransferItem & {
            webkitGetAsEntry?: () => unknown;
          }
        ).webkitGetAsEntry === "function";

      const queued: QueuedFile[] = supportsEntries
        ? await readDropAsQueuedFiles(dt.items)
        : filesToQueuedFiles(Array.from(dt.files));
      handleFiles(queued);
    },
    [handleFiles],
  );

  /* ─── browse fallback ───────────────────────────────────────── */

  const handleBrowseClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleBrowseFolderClick = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleInputChange = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        event.target.value = "";
        return;
      }
      handleFiles(filesToQueuedFiles(files));
      // Reset so the same file can be re-selected (browsers fire change
      // only when the selection differs from the previous one).
      event.target.value = "";
    },
    [handleFiles],
  );

  /* ─── render ────────────────────────────────────────────────── */

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => {
        void handleDrop(e);
      }}
      className={cn("relative", className)}
      data-testid="dropzone"
      aria-busy={isDragging || undefined}
    >
      {/* Always-visible hint + Browse button. Lives in a row above the
          wrapped content so it doesn't overlap the table. */}
      <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-dashed border-border bg-secondary/30 px-3 py-2 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <UploadCloud className="h-4 w-4" aria-hidden />
          <span>
            {T.hintLine1}{" "}
            <button
              type="button"
              onClick={handleBrowseClick}
              disabled={!ready}
              className="font-medium text-foreground underline-offset-2 transition-colors hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              aria-controls={inputId}
            >
              {T.hintBrowse}
            </button>
            {T.hintLine3}{" "}
            <span aria-hidden>·</span>{" "}
            <button
              type="button"
              onClick={handleBrowseFolderClick}
              disabled={!ready}
              className="font-medium text-foreground underline-offset-2 transition-colors hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              aria-controls={folderInputId}
            >
              {T.hintBrowseFolder}
            </button>
          </span>
        </span>
        <span className="text-xs text-muted-foreground">{T.maxFileSize}</span>

        {/* Hidden multi-file input drives the Browse button. `multiple`
            so the OS picker lets the user pick a batch. */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          className="sr-only"
          onChange={handleInputChange}
          // The picker inherits aria-busy from the parent already; no
          // need to expose the input itself to assistive tech beyond
          // the labelled Browse button.
          tabIndex={-1}
          aria-hidden
        />

        {/* Hidden folder picker driven by the second Browse button. */}
        <input
          ref={folderInputRef}
          id={folderInputId}
          type="file"
          multiple
          className="sr-only"
          onChange={handleInputChange}
          tabIndex={-1}
          aria-hidden
          // webkitdirectory/directory are non-standard and missing from React's
          // HTMLInputElement attribute types. Spread to bypass the TS type gap
          // without scattering @ts-expect-error pragmas.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
      </div>

      {children}

      {/* Drag-over visual. pointer-events-none so the underlying drop
          target keeps receiving the event. The overlay is borderless
          on top to align with the hint row above. */}
      {isDragging ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-md border-2 border-dashed border-primary bg-primary/5"
          aria-hidden
        >
          <div className="rounded-md bg-card px-4 py-3 text-sm font-medium text-foreground shadow-md">
            {T.dropTitle}{" "}
            <span className="font-mono">
              {bucket || T.noBucket}/{prefix}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────── */

/** Inspect a DataTransfer to confirm the drag is carrying files (and not
 *  text, URLs, or another tab's selection). Defensive across browsers:
 *  DataTransfer.types is a DOMStringList in Safari/older Edge and a
 *  plain array in modern Chrome/Firefox. */
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = dt.types;
  if (!types) return false;
  // Spread covers both DOMStringList (which lacks .includes) and plain
  // arrays; comparing to "Files" is the documented sentinel string.
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}
