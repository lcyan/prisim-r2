"use client";

interface OpsByTypeBarProps {
  data: Array<{ op: string; count: number }>;
}

const OP_COLOR: Record<string, string> = {
  "upload.create": "bg-primary",
  "upload.complete": "bg-primary",
  "object.delete": "bg-destructive",
  "share.create": "bg-success",
  "share.delete": "bg-warning",
  "presign.put": "bg-primary",
  "presign.get": "bg-info",
  "connection.create": "bg-success",
  "connection.delete": "bg-destructive",
  "auth.login": "bg-muted",
  "auth.logout": "bg-muted",
};

function colorOf(op: string): string {
  return OP_COLOR[op] ?? "bg-muted";
}

export function OpsByTypeBar({ data }: OpsByTypeBarProps) {
  const max = data.reduce((m, d) => Math.max(m, d.count), 0) || 1;
  if (data.length === 0) {
    return <p className="text-xs text-muted-foreground">暂无数据</p>;
  }
  return (
    <ul className="space-y-2 text-xs">
      {data.map((row) => (
        <li key={row.op}>
          <div className="flex items-center justify-between">
            <span className="truncate font-mono text-xs">{row.op}</span>
            <span className="font-mono text-muted-foreground tabular-nums">{row.count}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${colorOf(row.op)}`}
              style={{ width: `${(row.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
