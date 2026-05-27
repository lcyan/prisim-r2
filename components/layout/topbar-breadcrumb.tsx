"use client";

// components/layout/topbar-breadcrumb.tsx
//
// 渲染顶栏面包屑。把 resolveSegments(pathname) 的输出转成具体节点:
//   - connection → <TopbarConnectionPopover />
//   - bucket → <TopbarBucketPopover currentBucket={name} />
//   - prefix → 纯文本(最长保留最后两段,前面用 ".../")
//   - static → 纯文本

import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import {
  resolveSegments,
  type Segment,
} from "@/components/layout/breadcrumb-segments";
import { TopbarConnectionPopover } from "@/components/layout/topbar-connection-popover";
import { TopbarBucketPopover } from "@/components/layout/topbar-bucket-popover";

export function TopbarBreadcrumb() {
  const pathname = usePathname() ?? "";
  const segments = resolveSegments(pathname);

  if (segments.length === 0) return null;

  return (
    <nav aria-label="面包屑" className="flex items-center gap-1 text-sm">
      {segments.map((seg, idx) => (
        <span key={`${seg.kind}-${idx}`} className="flex items-center gap-1">
          {idx > 0 ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          ) : null}
          <SegmentNode segment={seg} />
        </span>
      ))}
    </nav>
  );
}

function SegmentNode({ segment }: { segment: Segment }) {
  switch (segment.kind) {
    case "connection":
      return <TopbarConnectionPopover />;
    case "bucket":
      return <TopbarBucketPopover currentBucket={segment.name} />;
    case "prefix":
      return <PrefixSegment path={segment.path} />;
    case "static":
      return (
        <span className="px-1 text-muted-foreground">{segment.label}</span>
      );
  }
}

function PrefixSegment({ path }: { path: string }) {
  // path 形如 "a/b/c/"。最长保留最后 2 段,前面用 .../
  const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
  let display: string;
  if (parts.length <= 2) {
    display = `${parts.join("/")}/`;
  } else {
    display = `…/${parts.slice(-2).join("/")}/`;
  }
  return (
    <span
      className="max-w-[280px] truncate px-1 font-mono text-xs text-foreground"
      title={path}
    >
      {display}
    </span>
  );
}
