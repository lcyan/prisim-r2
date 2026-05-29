"use client";

import Link from "next/link";
import { AlertCircle, Database, Loader2 } from "lucide-react";

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import type { BucketUsageSummary } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const T = {
  title: "存储桶",
  noConn: "请先在顶栏选择一个连接",
  empty: "暂无 Bucket",
  emptyHint: "去 Cloudflare 控制台新建 Bucket,然后回到这里。",
  loading: "加载中…",
  loadError: "无法加载存储桶列表",
  retry: "重试",
  created: (ms: number | null) =>
    ms == null ? "—" : new Date(ms).toLocaleDateString("zh-CN"),
  usageLoading: "统计中…",
  usageUnavailable: "用量暂不可用",
  objects: (count: number) => `${count.toLocaleString("zh-CN")} 个对象`,
  enter: "进入",
} as const;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function UsageBadge({ usage }: { usage: BucketUsageSummary | null }) {
  if (!usage) {
    return (
      <div className="text-right text-[11px] text-muted-foreground">
        {T.usageLoading}
      </div>
    );
  }

  if (usage.error) {
    return (
      <div className="text-right text-[11px] text-muted-foreground">
        {T.usageUnavailable}
      </div>
    );
  }

  const prefix = usage.truncated ? "≥ " : "";
  return (
    <div className="shrink-0 text-right tabular-nums">
      <p className="text-xs font-medium text-foreground">
        {prefix}
        {formatBytes(usage.totalBytes)}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {prefix}
        {T.objects(usage.objectCount)}
      </p>
    </div>
  );
}

export default function BucketsPage() {
  const activeId = useActiveConnectionStore((s) => s.activeConnectionId);
  const { data, isPending, isError, error, refetch, isFetching } =
    useBuckets(activeId);

  if (!activeId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {T.noConn}
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {T.loading}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <p>{T.loadError}</p>
        <p className="font-mono text-xs text-destructive/80">
          {(error as Error)?.message ?? ""}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="mt-2 rounded-md border border-border bg-card px-3 py-1 text-xs hover:bg-accent"
        >
          {T.retry}
        </button>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
        <p className="text-display text-lg font-medium text-foreground">
          {T.empty}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">{T.emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 px-6 py-8">
      <header>
        <p className="text-[11px] font-medium uppercase tracking-eyebrow text-muted-foreground">
          R2
        </p>
        <h1 className="text-display mt-1 text-2xl font-semibold tracking-tight">
          {T.title}
        </h1>
        <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
          {data.length} 个
        </p>
      </header>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data.map((bucket) => (
          <Link
            key={bucket.name}
            href={`/buckets/${encodeURIComponent(bucket.name)}`}
            className={cn(
              "group relative flex flex-col gap-3 overflow-hidden rounded-lg border border-border bg-card p-4 shadow-xs",
              "transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-md",
              // 顶部细线在 hover 时染上主色
              "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary/0 before:transition-colors before:duration-300",
              "hover:before:bg-primary/60",
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary text-primary transition-colors duration-200 group-hover:bg-primary/15">
                <Database className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm font-medium tracking-tight">
                  {bucket.name}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                  创建于 {T.created(bucket.createdAt)}
                </p>
              </div>
              <UsageBadge usage={bucket.usage} />
            </div>
            <div className="flex items-center justify-end gap-1 text-xs text-primary opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <span>{T.enter}</span>
              <span
                aria-hidden
                className="transition-transform duration-200 group-hover:translate-x-0.5"
              >
                →
              </span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
