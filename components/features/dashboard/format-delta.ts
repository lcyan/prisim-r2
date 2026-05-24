// components/features/dashboard/format-delta.ts
//
// KPI delta 计算。设计点:
//   - prev=0, curr=0 → null (无可比性,不显示 badge)
//   - prev=0, curr>0 → +∞ (UI 显示 "—" 字符)
//   - 其余 → 百分比四舍五入到 1 位小数

export interface DeltaResult {
  direction: "up" | "down" | "flat";
  pct: number; // 绝对值
  label: string; // 显示文案
}

export function formatDelta(current: number, previous: number): DeltaResult | null {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) {
    return { direction: "up", pct: Infinity, label: "—" };
  }
  const diff = current - previous;
  const pct = Math.abs((diff / previous) * 100);
  const rounded = Math.round(pct * 10) / 10;
  if (diff === 0) return { direction: "flat", pct: 0, label: "0.0%" };
  return {
    direction: diff > 0 ? "up" : "down",
    pct: rounded,
    label: `${diff > 0 ? "+" : "-"}${rounded.toFixed(1)}%`,
  };
}
