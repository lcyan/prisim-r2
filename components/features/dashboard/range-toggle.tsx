"use client";

import { cn } from "@/lib/utils";

const T = {
  range7d: "7 天",
  range30d: "30 天",
} as const;

export type DashboardRange = "7d" | "30d";

interface RangeToggleProps {
  value: DashboardRange;
  onChange: (next: DashboardRange) => void;
}

export function RangeToggle({ value, onChange }: RangeToggleProps) {
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("7d")}
        className={cn(
          "rounded-sm px-3 py-1 transition-colors",
          value === "7d"
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "7d"}
      >
        {T.range7d}
      </button>
      <button
        type="button"
        onClick={() => onChange("30d")}
        className={cn(
          "rounded-sm px-3 py-1 transition-colors",
          value === "30d"
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={value === "30d"}
      >
        {T.range30d}
      </button>
    </div>
  );
}
