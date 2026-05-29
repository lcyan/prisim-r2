"use client";

import { AlertCircle, Loader2 } from "lucide-react";

import { useDashboardSummary } from "@/hooks/use-dashboard";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { KpiCard } from "@/components/features/dashboard/kpi-card";
import { OpsByDayBar } from "@/components/features/dashboard/ops-by-day-bar";
import { OpsByTypeBar } from "@/components/features/dashboard/ops-by-type-bar";
import { RecentActivity } from "@/components/features/dashboard/recent-activity";
import { formatDelta } from "@/components/features/dashboard/format-delta";

const T = {
  title: "仪表盘",
  subTitle: (buckets: number) => `当前连接 · ${buckets} 个 Bucket`,
  noConn: "请先在顶栏选择一个连接",
  loading: "加载中…",
  loadError: "无法加载仪表盘数据",
  kpiBuckets: "Bucket 数",
  kpiShares: "活跃分享",
  shareExpiring: (n: number) => `${n} 个 7 天内过期`,
  kpiOps: "7 天操作",
  kpiFailures: "7 天失败率",
  failureHint: (n: number) => `共 ${n} 次`,
  chartArea: "操作量 · 7 天",
  chartBars: "操作类型 · 7 天",
  lowRecoveryCodes: (n: number) => `你的恢复码仅剩 ${n} 个，建议重新生成一批。`,
} as const;

export default function DashboardPage() {
  const activeId = useActiveConnectionStore((s) => s.activeConnectionId);
  const { data, isPending, isError, error } = useDashboardSummary(
    activeId,
    "7d",
  );

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
        <p className="font-mono text-xs text-destructive/80">{error.message}</p>
      </div>
    );
  }

  const opsDelta = formatDelta(data.ops.count, data.ops.previousCount);

  return (
    <div className="flex h-full flex-col gap-5 px-6 py-8">
      {data.totp.recoveryCodesRemaining <= 3 && (
        <div
          role="alert"
          className="relative flex items-start gap-3 overflow-hidden rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning-soft)] px-4 py-3 text-sm text-foreground"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-[3px] bg-[color:var(--warning)]"
          />
          <AlertCircle
            className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--warning)]"
            strokeWidth={2}
          />
          <p className="text-sm">
            {T.lowRecoveryCodes(data.totp.recoveryCodesRemaining)}
          </p>
        </div>
      )}
      <header>
        <p className="text-[11px] font-medium uppercase tracking-eyebrow text-muted-foreground">
          概览
        </p>
        <h1 className="text-display mt-1 text-2xl font-semibold tracking-tight">
          {T.title}
        </h1>
        <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
          {T.subTitle(data.bucketsCount)}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={T.kpiBuckets}
          value={data.bucketsCount.toLocaleString()}
        />
        <KpiCard
          label={T.kpiShares}
          value={data.shares.active.toLocaleString()}
          hint={
            data.shares.expiring7d > 0
              ? T.shareExpiring(data.shares.expiring7d)
              : undefined
          }
        />
        <KpiCard
          label={T.kpiOps}
          value={data.ops.count.toLocaleString()}
          delta={opsDelta}
        />
        <KpiCard
          label={T.kpiFailures}
          value={`${data.failures.ratePct.toFixed(2)}%`}
          hint={T.failureHint(data.failures.count)}
        />
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-5 shadow-xs lg:col-span-2">
          <h2 className="text-display mb-3 text-sm font-semibold tracking-tight">
            {T.chartArea}
          </h2>
          <OpsByDayBar data={data.opsByDay} />
        </div>
        <div className="rounded-lg border border-border bg-card p-5 shadow-xs">
          <h2 className="text-display mb-3 text-sm font-semibold tracking-tight">
            {T.chartBars}
          </h2>
          <OpsByTypeBar data={data.opsByType} />
        </div>
      </section>

      <RecentActivity rows={data.recentActivity} />
    </div>
  );
}
