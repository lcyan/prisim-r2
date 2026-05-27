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
    <div className="rounded-lg border border-border bg-card p-4 shadow-xs">
      <p className="text-xs tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
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
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
        color,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
      {delta.label}
    </span>
  );
}
