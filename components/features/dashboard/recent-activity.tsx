"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils";
import type { AuditEntry } from "@/lib/api/types";

const T = {
  title: "最近活动",
  viewAll: "查看全部",
  empty: "暂无记录",
} as const;

interface RecentActivityProps {
  rows: AuditEntry[];
}

export function RecentActivity({ rows }: RecentActivityProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-xs">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{T.title}</h2>
        <Link href="/audit" className="text-xs text-primary hover:underline">
          {T.viewAll} →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{T.empty}</p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {rows.map((row) => (
            <li
              key={row.id}
              className="grid grid-cols-[80px_120px_1fr_auto] items-center gap-2"
            >
              <span className="text-muted-foreground">
                {formatRelative(new Date(row.createdAt))}
              </span>
              <Badge
                variant={row.status === "success" ? "secondary" : "destructive"}
                className="justify-self-start font-mono text-xs"
              >
                {row.op}
              </Badge>
              <span
                className="truncate font-mono text-foreground"
                title={`${row.bucket ?? ""} / ${row.key ?? ""}`}
              >
                {row.bucket ? `${row.bucket} / ` : ""}
                {row.key ?? "—"}
              </span>
              <span className="text-muted-foreground">{row.bucket ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
