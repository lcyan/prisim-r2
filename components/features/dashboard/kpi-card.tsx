"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";

import type { DeltaResult } from "@/components/features/dashboard/format-delta";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  delta?: DeltaResult | null;
  hint?: string;
}

export function KpiCard({ label, value, delta, hint }: KpiCardProps) {
  return (
    <div
      className={cn(
        // 关系:组合 hover 抬升 + 顶部 hairline accent。
        // before:absolute 那条 1px 主色线是 KPI 卡片的“信号灯”,
        // 让通用卡片有了一处不可替代的细节,避免 generic dashboard 感。
        "group relative overflow-hidden rounded-lg border border-border bg-card p-5 shadow-xs",
        "transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md hover:border-foreground/12",
        "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary/0 before:transition-colors before:duration-300",
        "hover:before:bg-primary/60",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-eyebrow text-muted-foreground">
        {label}
      </p>
      <p className="text-display mt-3 text-[28px] font-semibold leading-none tabular-nums text-foreground">
        {value}
      </p>
      <div className="mt-2.5 flex min-h-[18px] items-center gap-2 text-xs">
        {delta ? <DeltaBadge delta={delta} /> : null}
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

function DeltaBadge({ delta }: { delta: DeltaResult }) {
  const Icon =
    delta.direction === "up"
      ? ArrowUp
      : delta.direction === "down"
        ? ArrowDown
        : ArrowRight;
  const color =
    delta.direction === "up"
      ? "text-success bg-success/10"
      : delta.direction === "down"
        ? "text-destructive bg-destructive/10"
        : "text-muted-foreground bg-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums",
        color,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2.25} />
      {delta.label}
    </span>
  );
}
