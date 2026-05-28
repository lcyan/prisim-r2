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
    <div className="rounded-lg border border-border bg-card p-5 shadow-xs">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-display text-sm font-semibold tracking-tight">
          {T.title}
        </h2>
        <Link
          href="/audit"
          className="group/link inline-flex items-center gap-1 text-xs text-primary transition-colors hover:text-[color:var(--primary-active)]"
        >
          {T.viewAll}
          <span
            aria-hidden
            className="transition-transform duration-200 group-hover/link:translate-x-0.5"
          >
            →
          </span>
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{T.empty}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {rows.map((row) => (
            <li
              key={row.id}
              className="grid grid-cols-[88px_128px_1fr_auto] items-center gap-3 rounded-sm py-1.5 transition-colors hover:bg-accent/30"
            >
              <span className="tabular-nums text-muted-foreground">
                {formatRelative(new Date(row.createdAt))}
              </span>
              <Badge
                variant={row.status === "success" ? "secondary" : "destructive"}
                className="justify-self-start font-mono text-[10px] uppercase tracking-wider"
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
