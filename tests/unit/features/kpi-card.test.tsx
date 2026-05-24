import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { KpiCard } from "@/components/features/dashboard/kpi-card";

describe("KpiCard", () => {
  it("renders label and value", () => {
    render(<KpiCard label="活跃分享" value="12" />);
    expect(screen.getByText("活跃分享")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("shows up delta with success color", () => {
    render(
      <KpiCard
        label="30 天操作"
        value="1,247"
        delta={{ direction: "up", pct: 12, label: "+12.0%" }}
      />,
    );
    const badge = screen.getByText("+12.0%");
    expect(badge.className).toMatch(/text-success|bg-success/);
  });

  it("shows down delta with danger color", () => {
    render(
      <KpiCard
        label="出口"
        value="87"
        delta={{ direction: "down", pct: 4, label: "-4.0%" }}
      />,
    );
    const badge = screen.getByText("-4.0%");
    expect(badge.className).toMatch(/text-destructive|bg-destructive/);
  });

  it("renders hint when provided", () => {
    render(<KpiCard label="活跃分享" value="12" hint="3 个 7 天内过期" />);
    expect(screen.getByText("3 个 7 天内过期")).toBeInTheDocument();
  });
});
