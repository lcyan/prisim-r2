"use client";

import { type ReactNode } from "react";
import {
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  Image as ImageIcon,
  MoreHorizontal,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { cn, formatBytes, formatRelative } from "@/lib/utils";

/**
 * FileTable — primary object browser surface.
 * Layout: sticky toolbar (breadcrumb + bulk actions) + dense table + cursor pager.
 *
 * Pure presentational skeleton — no fetching. Wire to `useObjects(bucket, prefix)`
 * (TanStack Query useInfiniteQuery) at the page level. selected/onSelect drives
 * the Zustand `selectedKeys` store from CLAUDE.md.
 */

export type FileRow = {
  key: string; // full key (e.g. "logs/2026/05/a.txt") or prefix ("logs/")
  kind: "file" | "prefix";
  size?: number;
  modified?: Date;
  /** lowercase extension without dot, e.g. "png" */
  extension?: string;
};

interface FileTableProps {
  bucket: string;
  prefix: string;
  items: FileRow[];
  selected: Set<string>;
  onSelect: (key: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onNavigate: (newPrefix: string) => void;
  onAction: (action: RowAction, row: FileRow) => void;
  onUpload: () => void;
  onBulkDelete: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  emptyHint?: ReactNode;
}

type RowAction = "preview" | "download" | "share" | "delete";

export function FileTable({
  bucket,
  prefix,
  items,
  selected,
  onSelect,
  onSelectAll,
  onNavigate,
  onAction,
  onUpload,
  onBulkDelete,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  emptyHint,
}: FileTableProps) {
  const segments = prefix
    ? prefix.replace(/\/$/, "").split("/").filter(Boolean)
    : [];
  const allSelected =
    items.length > 0 && items.every((i) => selected.has(i.key));
  const someSelected = selected.size > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        bucket={bucket}
        segments={segments}
        selectedCount={selected.size}
        someSelected={someSelected}
        onNavigate={onNavigate}
        onUpload={onUpload}
        onBulkDelete={onBulkDelete}
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
                  className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)]"
                  aria-label="Select all rows"
                />
              </Th>
              <Th>Name</Th>
              <Th className="w-32 text-right">Size</Th>
              <Th className="w-44">Modified</Th>
              <Th className="w-28 pr-4 text-right">Actions</Th>
            </tr>
          </thead>

          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-20 text-center">
                  <p className="font-display text-lg italic text-muted-foreground">
                    This prefix is empty.
                  </p>
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    {emptyHint ??
                      "Drag files anywhere or use the Upload button."}
                  </p>
                </td>
              </tr>
            ) : (
              items.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  selected={selected.has(row.key)}
                  onSelect={onSelect}
                  onNavigate={onNavigate}
                  onAction={onAction}
                />
              ))
            )}
          </tbody>
        </table>

        {hasMore && onLoadMore ? (
          <div className="flex justify-center py-6">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={isLoadingMore}
              className="inline-flex h-8 items-center rounded-md border border-border bg-card px-4 font-mono text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
            >
              {isLoadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function Toolbar({
  bucket,
  segments,
  selectedCount,
  someSelected,
  onNavigate,
  onUpload,
  onBulkDelete,
}: {
  bucket: string;
  segments: string[];
  selectedCount: number;
  someSelected: boolean;
  onNavigate: (prefix: string) => void;
  onUpload: () => void;
  onBulkDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
      <nav
        className="flex min-w-0 items-baseline gap-1 overflow-hidden"
        aria-label="Breadcrumb"
      >
        <button
          type="button"
          onClick={() => onNavigate("")}
          className="font-display text-2xl font-semibold tracking-tight text-foreground transition-colors hover:text-primary"
        >
          {bucket}
        </button>
        {segments.map((seg, i) => {
          const segPrefix = segments.slice(0, i + 1).join("/") + "/";
          const isLast = i === segments.length - 1;
          return (
            <span key={segPrefix} className="flex items-baseline gap-1">
              <ChevronRight className="mx-0.5 h-3.5 w-3.5 self-center text-muted-foreground" />
              <button
                type="button"
                onClick={() => onNavigate(segPrefix)}
                className={cn(
                  "max-w-[16ch] truncate font-mono text-sm transition-colors",
                  isLast
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        {someSelected ? (
          <>
            <span className="font-mono text-xs text-muted-foreground">
              {selectedCount} selected
            </span>
            <button
              type="button"
              onClick={onBulkDelete}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          </>
        ) : null}
        <button
          type="button"
          onClick={onUpload}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload
        </button>
      </div>
    </div>
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

/* ──────────────────────────────────────────────────────────── */

function Row({
  row,
  selected,
  onSelect,
  onNavigate,
  onAction,
}: {
  row: FileRow;
  selected: boolean;
  onSelect: (key: string, selected: boolean) => void;
  onNavigate: (prefix: string) => void;
  onAction: (action: RowAction, row: FileRow) => void;
}) {
  const displayName = row.key.split("/").filter(Boolean).pop() ?? row.key;
  const isPrefix = row.kind === "prefix";

  return (
    <tr
      data-selected={selected}
      className={cn(
        "group relative h-10 border-b border-border/60 transition-colors",
        "hover:bg-accent/40",
        selected && "bg-primary/[0.05] signal-bar",
      )}
    >
      <td className="pl-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(row.key, e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)]"
          aria-label={`Select ${displayName}`}
        />
      </td>
      <td className="px-2">
        <div className="flex items-center gap-2.5">
          <FileGlyph kind={row.kind} extension={row.extension} />
          {isPrefix ? (
            <button
              type="button"
              onClick={() => onNavigate(row.key)}
              className="truncate text-left font-medium text-foreground transition-colors hover:text-primary"
            >
              {displayName}
              <span className="text-muted-foreground">/</span>
            </button>
          ) : (
            <span className="truncate text-foreground">{displayName}</span>
          )}
          {!isPrefix && row.extension ? (
            <span className="ml-1 rounded-xs bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-secondary-foreground">
              {row.extension}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {row.kind === "file" ? formatBytes(row.size ?? 0) : "—"}
      </td>
      <td className="px-2 font-mono text-xs text-muted-foreground">
        {row.modified ? formatRelative(row.modified) : "—"}
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
  kind: FileRow["kind"];
  extension?: string;
}) {
  if (kind === "prefix") {
    return (
      <Folder
        className="h-4 w-4 shrink-0 text-muted-foreground"
        strokeWidth={1.5}
      />
    );
  }
  const isImage =
    extension && /^(png|jpg|jpeg|gif|webp|svg|avif)$/i.test(extension);
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
  row: FileRow;
  onAction: (a: RowAction, row: FileRow) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <ActionButton label="Preview" onClick={() => onAction("preview", row)}>
        <Eye className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton label="Download" onClick={() => onAction("download", row)}>
        <Download className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton label="Share" onClick={() => onAction("share", row)}>
        <Share2 className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton
        label="Delete"
        onClick={() => onAction("delete", row)}
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
