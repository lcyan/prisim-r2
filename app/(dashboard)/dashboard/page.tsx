"use client";

import Link from "next/link";

const T = {
  title: "仪表盘",
  comingSoon: "仪表盘内容将在后续版本上线。",
  cta: "去存储桶",
} as const;

export default function DashboardPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.comingSoon}</p>
      <Link
        href="/buckets"
        className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        {T.cta}
      </Link>
    </div>
  );
}
