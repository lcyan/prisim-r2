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
    // Segmented control with a sliding pill indicator. The active item is
    // identified via data-state; the indicator pill rides relative width
    // from a single grid column track so the animation is GPU-friendly
    // (transform/opacity only). Replaces the previous two-button bg swap
    // which had no motion between states.
    <div
      role="tablist"
      aria-label="时间范围"
      className="relative inline-flex h-8 items-center rounded-md border border-border bg-card p-0.5 text-xs shadow-xs"
    >
      <SlidingIndicator active={value} />
      <Tab
        active={value === "7d"}
        onClick={() => onChange("7d")}
        label={T.range7d}
      />
      <Tab
        active={value === "30d"}
        onClick={() => onChange("30d")}
        label={T.range30d}
      />
    </div>
  );
}

function Tab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-state={active ? "active" : "inactive"}
      className={cn(
        "relative z-10 inline-flex h-7 min-w-[3.75rem] items-center justify-center rounded-[5px] px-3 font-medium transition-colors duration-200",
        active
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function SlidingIndicator({ active }: { active: DashboardRange }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded-[5px] bg-primary/[0.10] shadow-[inset_0_0_0_1px_var(--primary-soft-strong)]",
        "transition-transform duration-300 ease-out",
        active === "30d" && "translate-x-full",
      )}
    />
  );
}
