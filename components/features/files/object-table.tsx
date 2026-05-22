"use client";

// components/features/files/object-table.tsx
//
// The object browser's main surface — a dense table of folders + files for
// one R2 prefix. Pure-ish: pagination state, error state, and the parent's
// onFolderClick handler all come in as props; multi-selection state is read
// from the `useSelectedKeysStore` Zustand store so cross-page selection
// works without prop drilling.
//
// What this component does NOT do (intentional):
//   * The breadcrumb is rendered by the page — see breadcrumb.tsx.
//   * It does NOT decide what `Download` / `Share` / `Preview` / `Delete`
//     actually do. Per-row action handlers are wired by the parent through
//     `onAction(action, row)`; in the current task scope (14.4/14.5) the
//     parent leaves these as no-ops. Subsequent tasks (presign-based
//     downloads, share-link dialog, delete confirmation) will replace the
//     no-op with the real call site. The action surface staying inert here
//     means task 14 can ship before tasks 15+ are written.

import { type ReactNode } from "react";
import {
  AlertTriangle,
  Download,
  Eye,
  FileText,
  Folder,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Share2,
  Trash2,
} from "lucide-react";

import { useSelectedKeysStore } from "@/stores/selected-keys";
import { cn, formatBytes, formatRelative } from "@/lib/utils";

/**
 * One row in the table. Folders come from `prefixes` (key already ends with
 * "/"); files come from `objects` (size + lastModified populated).
 */
export type ObjectRow =
  | {
      kind: "prefix";
      /** Full prefix key, ALWAYS with trailing "/" — matches what R2
       *  returns under CommonPrefixes. */
      key: string;
    }
  | {
      kind: "file";
      key: string;
      /** Bytes. Server normalizes missing values to null. */
      size: number | null;
      /** Epoch ms. Server normalizes missing values to null. */
      lastModified: number | null;
    };

export type RowAction = "preview" | "download" | "share" | "delete";

export interface ObjectTableProps {
  items: ObjectRow[];
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  /** Called when the user clicks a folder row. Receives the "child name"
   *  (the last segment of the prefix, no trailing slash) so the page can
   *  compose the new prefix via `joinPrefix(currentPrefix, child)`. */
  onFolderClick: (child: string) => void;
  /** Called when the user fires a row-level action. No-op acceptable. */
  onAction?: (action: RowAction, row: ObjectRow) => void;
  /** Called when the user clicks "Delete" in the selection banner. The
   *  selected keys live in the Zustand store; the page reads them there
   *  rather than threading them through this prop. */
  onBulkDelete?: () => void;
  /** Cursor pagination state from useInfiniteQuery. */
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** Total count of selected rows across all loaded pages — used to render
   *  the bulk-action banner above the table. */
  selectedCount: number;
  /** Called from the "Clear selection" banner button. */
  onClearSelection: () => void;
}

/** Extract the trailing segment of a prefix key (`"a/b/c/" → "c"`).
 *  Exported for tests; the row Render uses it inline. */
export function folderDisplayName(prefixKey: string): string {
  return prefixKey.replace(/\/+$/u, "").split("/").pop() ?? prefixKey;
}

/** Extract just the filename of a key (`"logs/2026/a.txt" → "a.txt"`). */
export function fileDisplayName(key: string): string {
  return key.split("/").filter(Boolean).pop() ?? key;
}

/** Lowercase extension without dot (`"foo.PNG" → "png"`). Empty when none. */
export function fileExtension(key: string): string {
  const name = fileDisplayName(key);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function ObjectTable({
  items,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onFolderClick,
  onAction,
  onBulkDelete,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  selectedCount,
  onClearSelection,
}: ObjectTableProps) {
  // Subscribe directly to the store so the table updates the instant a
  // checkbox flips, without round-tripping through the page.
  const selectedKeys = useSelectedKeysStore((s) => s.selectedKeys);
  const toggle = useSelectedKeysStore((s) => s.toggle);
  const setSelection = useSelectedKeysStore((s) => s.setSelection);

  const allKeys = items.map((i) => i.key);
  const allSelected =
    items.length > 0 && items.every((i) => selectedKeys.has(i.key));

  const onSelectAll = (checked: boolean) => {
    if (checked) {
      // Merge with existing — the user may have selections from earlier
      // pages they don't want clobbered by "select visible".
      const merged = new Set(selectedKeys);
      for (const k of allKeys) merged.add(k);
      setSelection(Array.from(merged));
    } else {
      // Clear ONLY the visible page's keys; keep selections from prior
      // pages intact. Matches the convention in the major cloud-storage
      // UIs.
      const next = new Set(selectedKeys);
      for (const k of allKeys) next.delete(k);
      setSelection(Array.from(next));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-border bg-card">
      <SelectionBanner
        selectedCount={selectedCount}
        onClearSelection={onClearSelection}
        onBulkDelete={() => onBulkDelete?.()}
      />

      <div className="flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
            <tr className="h-9">
              <Th className="w-10 pl-4">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onSelectAll(e.target.checked)}
                  disabled={items.length === 0}
                  className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Select all rows on this page"
                />
              </Th>
              <Th>Name</Th>
              <Th className="w-32 text-right">Size</Th>
              <Th className="w-44">Modified</Th>
              <Th className="w-28 pr-4 text-right">Actions</Th>
            </tr>
          </thead>

          <tbody>
            <TableBody
              items={items}
              isLoading={isLoading}
              isError={isError}
              errorMessage={errorMessage}
              onRetry={onRetry}
              onFolderClick={onFolderClick}
              onAction={onAction}
              selectedKeys={selectedKeys}
              onToggle={toggle}
            />
          </tbody>
        </table>

        {hasNextPage ? (
          <div className="flex justify-center py-6">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={isFetchingNextPage}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-4 font-mono text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetchingNextPage ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function SelectionBanner({
  selectedCount,
  onClearSelection,
  onBulkDelete,
}: {
  selectedCount: number;
  onClearSelection: () => void;
  onBulkDelete: () => void;
}) {
  // Nothing to show — keeping the banner mounted but invisible would push
  // table content down on every selection change; conditionally rendering
  // is cleaner.
  if (selectedCount === 0) return null;
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-primary/[0.04] px-4 py-2">
      <span className="font-mono text-xs text-foreground">
        {selectedCount} selected
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBulkDelete}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function TableBody({
  items,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onFolderClick,
  onAction,
  selectedKeys,
  onToggle,
}: {
  items: ObjectRow[];
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onFolderClick: (child: string) => void;
  onAction?: (action: RowAction, row: ObjectRow) => void;
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  // Error takes priority over loading: a stuck "Loading…" while we already
  // know the request failed is worse than the user seeing the retry button.
  if (isError) {
    return (
      <tr>
        <td colSpan={5} className="px-6 py-16 text-center">
          <AlertTriangle
            className="mx-auto h-5 w-5 text-destructive"
            strokeWidth={1.5}
          />
          <p className="mt-3 text-sm text-destructive">
            {errorMessage ?? "Couldn’t load objects."}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            Retry
          </button>
        </td>
      </tr>
    );
  }

  if (isLoading) {
    return (
      <tr>
        <td colSpan={5} className="px-6 py-16 text-center">
          <Loader2
            className="mx-auto h-5 w-5 animate-spin text-muted-foreground"
            strokeWidth={1.5}
          />
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Loading…
          </p>
        </td>
      </tr>
    );
  }

  if (items.length === 0) {
    return (
      <tr>
        <td colSpan={5} className="px-6 py-20 text-center">
          <p className="font-display text-lg italic text-muted-foreground">
            This prefix is empty.
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Use the Upload button to drop files here.
          </p>
        </td>
      </tr>
    );
  }

  return (
    <>
      {items.map((row) => (
        <Row
          key={row.key}
          row={row}
          selected={selectedKeys.has(row.key)}
          onToggle={onToggle}
          onFolderClick={onFolderClick}
          onAction={onAction}
        />
      ))}
    </>
  );
}

function Th({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-2 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Row({
  row,
  selected,
  onToggle,
  onFolderClick,
  onAction,
}: {
  row: ObjectRow;
  selected: boolean;
  onToggle: (key: string) => void;
  onFolderClick: (child: string) => void;
  onAction?: (action: RowAction, row: ObjectRow) => void;
}) {
  const isPrefix = row.kind === "prefix";
  const displayName = isPrefix
    ? folderDisplayName(row.key)
    : fileDisplayName(row.key);
  const extension = isPrefix ? "" : fileExtension(row.key);

  return (
    <tr
      data-selected={selected}
      className={cn(
        "group relative h-10 border-b border-border/60 transition-colors",
        "hover:bg-accent/40",
        selected && "bg-primary/[0.05]",
      )}
    >
      <td className="pl-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(row.key)}
          className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)]"
          aria-label={`Select ${displayName}`}
        />
      </td>
      <td className="px-2">
        <div className="flex items-center gap-2.5">
          <FileGlyph kind={row.kind} extension={extension} />
          {isPrefix ? (
            <button
              type="button"
              onClick={() => onFolderClick(displayName)}
              className="truncate text-left font-medium text-foreground transition-colors hover:text-primary"
            >
              {displayName}
              <span className="text-muted-foreground">/</span>
            </button>
          ) : (
            <span className="truncate text-foreground">{displayName}</span>
          )}
          {!isPrefix && extension ? (
            <span className="ml-1 rounded-xs bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-secondary-foreground">
              {extension}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {row.kind === "file" ? formatBytes(row.size ?? 0) : "—"}
      </td>
      <td className="px-2 font-mono text-xs text-muted-foreground">
        {row.kind === "file" && row.lastModified
          ? formatRelative(new Date(row.lastModified))
          : "—"}
      </td>
      <td className="pr-4 text-right">
        {row.kind === "file" ? (
          <RowActions row={row} onAction={onAction} />
        ) : null}
      </td>
    </tr>
  );
}

function FileGlyph({
  kind,
  extension,
}: {
  kind: ObjectRow["kind"];
  extension: string;
}) {
  if (kind === "prefix") {
    return (
      <Folder
        className="h-4 w-4 shrink-0 text-muted-foreground"
        strokeWidth={1.5}
      />
    );
  }
  const isImage = /^(png|jpg|jpeg|gif|webp|svg|avif)$/i.test(extension);
  const Icon = isImage ? ImageIcon : FileText;
  return (
    <Icon
      className="h-4 w-4 shrink-0 text-muted-foreground"
      strokeWidth={1.5}
    />
  );
}

function RowActions({
  row,
  onAction,
}: {
  row: ObjectRow;
  onAction?: (action: RowAction, row: ObjectRow) => void;
}) {
  // No-op fallback so the buttons stay interactive (and keyboard-reachable)
  // even before tasks 15/16/17 wire up Preview / Download / Share. Without
  // the fallback an undefined handler would render disabled-looking buttons.
  const handle = (action: RowAction) => onAction?.(action, row);
  return (
    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <ActionButton label="Preview" onClick={() => handle("preview")}>
        <Eye className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton label="Download" onClick={() => handle("download")}>
        <Download className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton label="Share" onClick={() => handle("share")}>
        <Share2 className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton
        label="Delete"
        onClick={() => handle("delete")}
        destructive
      >
        <Trash2 className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton label="More" onClick={() => {}}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </ActionButton>
    </div>
  );
}

function ActionButton({
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
        "grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors",
        destructive
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
