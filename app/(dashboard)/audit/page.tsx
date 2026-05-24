"use client";

// app/(dashboard)/audit/page.tsx
//
// /audit — read-only view of the current user's audit_log rows. Each row
// shows Time / Op (badge) / Bucket / Key / Status / IP. Op selection and
// bucket-name filter narrow the listing server-side; changing either
// resets pagination because the filters are part of the TanStack Query
// key (see hooks/use-audit.ts).
//
// V1 deliberately omits CSV export — the use-case in the brief is
// "spot-check an action that just happened", not "data extraction".
// V2 can add export once we know the row counts in practice.

import { useState } from "react";
import { AlertTriangle, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAudit, type AuditFilters } from "@/hooks/use-audit";
import { AUDIT_OP_VALUES, type AuditOpValue } from "@/lib/api/schemas";
import { formatRelative } from "@/lib/utils";
import type { AuditEntry } from "@/lib/api/types";

const T = {
  pageTitle: "审计日志",
  pageDesc: "账户内的状态变更操作记录。只读。",
  thTime: "时间",
  thOp: "操作",
  thBucket: "Bucket",
  thKey: "Key",
  thStatus: "状态",
  thIp: "IP",
  opLabel: "操作类型",
  bucketLabel: "存储桶",
  opAll: "全部",
  bucketPlaceholder: "精确 bucket 名…",
  loadMore: "加载更多",
  loading: "加载中…",
  loadError: "无法加载审计日志",
  retry: "重试",
  emptyTitle: "暂无审计记录",
  emptyHint: "随着你使用本应用，操作会被记录在这里。试试移除筛选条件。",
  arOpAria: "按操作类型筛选",
  arBucketAria: "按 bucket 名筛选",
  statusSuccess: "成功",
  statusFailure: "失败",
} as const;

export default function AuditPage() {
  // The op input is "" when the user picks "All" — translate to undefined
  // at the boundary so the query key normalizes the same way regardless
  // of whether the user actively cleared the filter or never set it.
  const [opFilter, setOpFilter] = useState<"" | AuditOpValue>("");
  // bucket text input is uncontrolled-ish — we DEBOUNCE-free here: the
  // user submits by tabbing/blurring/pressing Enter, which fires onBlur /
  // change naturally. The page-size cap (100) plus single-indexed query
  // means even a "no filter" request is cheap enough that we don't need
  // a debounce.
  const [bucketFilter, setBucketFilter] = useState<string>("");

  const filters: AuditFilters = {};
  if (opFilter) filters.op = opFilter;
  if (bucketFilter.trim().length > 0) filters.bucket = bucketFilter.trim();

  const {
    data,
    isPending,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useAudit(filters);

  const rows: AuditEntry[] = data
    ? data.pages.flatMap((p) => p.items)
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <Header />
      <FilterBar
        op={opFilter}
        bucket={bucketFilter}
        onOpChange={setOpFilter}
        onBucketChange={setBucketFilter}
      />

      <div className="flex-1 overflow-auto rounded-md border border-border bg-card">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
            <tr className="h-9">
              <Th className="w-36 pl-4">{T.thTime}</Th>
              <Th className="w-44">{T.thOp}</Th>
              <Th className="w-40">{T.thBucket}</Th>
              <Th>{T.thKey}</Th>
              <Th className="w-24">{T.thStatus}</Th>
              <Th className="w-32 pr-4">{T.thIp}</Th>
            </tr>
          </thead>
          <tbody>
            <Body
              isPending={isPending}
              isError={isError}
              errorMessage={error?.message ?? null}
              rows={rows}
              onRetry={() => void refetch()}
            />
          </tbody>
        </table>

        {hasNextPage ? (
          <div className="flex justify-center py-6">
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-4 font-mono text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetchingNextPage ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {T.loading}
                </>
              ) : (
                T.loadMore
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function Header() {
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{T.pageTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {T.pageDesc}
        </p>
      </div>
    </div>
  );
}

function FilterBar({
  op,
  bucket,
  onOpChange,
  onBucketChange,
}: {
  op: "" | AuditOpValue;
  bucket: string;
  onOpChange: (next: "" | AuditOpValue) => void;
  onBucketChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{T.opLabel}</span>
        <select
          value={op}
          onChange={(e) => onOpChange(e.target.value as "" | AuditOpValue)}
          className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={T.arOpAria}
        >
          <option value="">{T.opAll}</option>
          {AUDIT_OP_VALUES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground sm:max-w-xs">
        <span>{T.bucketLabel}</span>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={bucket}
            onChange={(e) => onBucketChange(e.target.value)}
            placeholder={T.bucketPlaceholder}
            className="pl-7 font-mono text-xs"
            aria-label={T.arBucketAria}
          />
        </div>
      </label>
    </div>
  );
}

function Body({
  isPending,
  isError,
  errorMessage,
  rows,
  onRetry,
}: {
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
  rows: AuditEntry[];
  onRetry: () => void;
}) {
  if (isError) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-16 text-center">
          <AlertTriangle
            className="mx-auto h-5 w-5 text-destructive"
            strokeWidth={1.5}
          />
          <p className="mt-3 text-sm text-destructive">
            {errorMessage ?? T.loadError}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {T.retry}
          </button>
        </td>
      </tr>
    );
  }

  if (isPending) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-16 text-center">
          <Loader2
            className="mx-auto h-5 w-5 animate-spin text-muted-foreground"
            strokeWidth={1.5}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            {T.loading}
          </p>
        </td>
      </tr>
    );
  }

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-20 text-center">
          <p className="font-display text-lg italic text-muted-foreground">
            {T.emptyTitle}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {T.emptyHint}
          </p>
        </td>
      </tr>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </>
  );
}

function Row({ row }: { row: AuditEntry }) {
  return (
    <tr className="group h-11 border-b border-border/60 transition-colors hover:bg-accent/40">
      <td
        className="pl-4 text-xs text-muted-foreground"
        title={new Date(row.createdAt).toISOString()}
      >
        {formatRelative(new Date(row.createdAt))}
      </td>
      <td className="px-2">
        <Badge variant="outline" className="font-mono text-[10px]">
          {row.op}
        </Badge>
      </td>
      <td className="px-2 truncate font-mono text-xs text-muted-foreground">
        {row.bucket ?? "—"}
      </td>
      <td className="px-2">
        <span
          className="block truncate font-mono text-xs text-foreground"
          title={row.key ?? ""}
        >
          {row.key ?? "—"}
        </span>
        {row.errorMsg ? (
          <span
            className="block truncate font-mono text-xs text-destructive"
            title={row.errorMsg}
          >
            {row.errorMsg}
          </span>
        ) : null}
      </td>
      <td className="px-2">
        <Badge
          variant={row.status === "success" ? "secondary" : "destructive"}
          className="text-xs"
        >
          {row.status === "success" ? T.statusSuccess : T.statusFailure}
        </Badge>
      </td>
      <td
        className="pr-4 truncate font-mono text-[11px] text-muted-foreground"
        title={row.ua ?? row.ip ?? ""}
      >
        {row.ip ?? "—"}
      </td>
    </tr>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left text-xs font-medium text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </th>
  );
}
