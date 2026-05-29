import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const barChartProps: unknown[] = [];

vi.mock("@/components/charts/bar-chart", () => ({
  BarChart: (props: unknown) => {
    barChartProps.push(props);
    return <div data-testid="bar-chart" />;
  },
}));

import { OpsByDayBar } from "@/components/features/dashboard/ops-by-day-bar";

describe("OpsByDayBar", () => {
  it("allows intermediate date ticks on the 30 day timeline", () => {
    const data = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      count: i,
    }));

    render(<OpsByDayBar data={data} />);

    expect(barChartProps).toHaveLength(1);
    expect(barChartProps[0]).toMatchObject({
      intervalType: "preserveStartEnd",
    });
    expect(barChartProps[0]).not.toMatchObject({ startEndOnly: true });
  });
});
