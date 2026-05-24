"use client";

import Link from "next/link";
import { AlertCircle, Database, Loader2 } from "lucide-react";

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";

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
  enter: "进入",
} as const;

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
        <p className="font-display text-lg italic text-muted-foreground">
          {T.empty}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">{T.emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{data.length} 个</p>
      </header>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data.map((bucket) => (
          <Link
            key={bucket.name}
            href={`/buckets/${encodeURIComponent(bucket.name)}`}
            className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Database className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm font-medium">
                  {bucket.name}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  创建于 {T.created(bucket.createdAt)}
                </p>
              </div>
            </div>
            <p className="text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
              {T.enter} →
            </p>
          </Link>
        ))}
      </section>
    </div>
  );
}
