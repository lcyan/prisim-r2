"use client";

import { AreaChart } from "@/components/charts/area-chart";

interface OpsAreaChartProps {
  data: Array<{ date: string; count: number }>;
}

// Tremor 的 colors 取自 chartColors map（固定 Tailwind 色板:blue / emerald / violet / amber / ...）。
// 这里选 "blue" 而非 plan 写的 "primary":Tremor 把颜色名转成 `text-blue-500` 这种字面类名,
// 不走我们的 --primary token。要让图表跟主色联动需要扩展 chartColors 加 primary alias 条目,
// 留到 Phase 4.7 / Phase 5 一起处理(blue 主题用户当前视觉一致;orange/green 主题暂会看到蓝色)。
export function OpsAreaChart({ data }: OpsAreaChartProps) {
  return (
    <AreaChart
      data={data}
      index="date"
      categories={["count"]}
      colors={["blue"]}
      showLegend={false}
      yAxisWidth={40}
      className="h-[180px]"
    />
  );
}
