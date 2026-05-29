"use client";

import { BarChart } from "@/components/charts/bar-chart";

interface OpsByDayBarProps {
  data: Array<{ date: string; count: number }>;
}

// 用柱状图而非 area:7d/30d 内大量为零的天用 area 渲染会近似平线,
// 用户感知为"图表空的"(实际上是末尾一两天有陡坡)。柱状图把每天画
// 成独立的槽位,有值的天直接立起一根柱子,稀疏分布也一眼可读。
//
// colors=blue:Tremor 的 colors map 用字面 Tailwind 类名(text-blue-500
// 等),不走我们的 --primary token。蓝色主题视觉一致;orange/green 暂会
// 看到蓝色 — Phase 4.7 / Phase 5 一起扩 chartColors。
export function OpsByDayBar({ data }: OpsByDayBarProps) {
  return (
    <BarChart
      data={data}
      index="date"
      categories={["count"]}
      colors={["blue"]}
      showLegend={false}
      yAxisWidth={40}
      intervalType="preserveStartEnd"
      className="h-[180px]"
    />
  );
}
