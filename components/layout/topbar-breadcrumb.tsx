"use client";

// components/layout/topbar-breadcrumb.tsx
//
// 渲染顶栏面包屑。把 resolveSegments(pathname) 的输出转成具体节点:
//   - connection → <TopbarConnectionPopover />
//   - bucket → <TopbarBucketPopover currentBucket={name} />
//   - prefix → 父级为可点击链接，当前级为纯文本
//   - static → 纯文本

import Link from "next/link";
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
      return <PrefixSegment segment={segment} />;
    case "static":
      return (
        <span className="px-1 text-muted-foreground">{segment.label}</span>
      );
  }
}

function PrefixSegment({
  segment,
}: {
  segment: Extract<Segment, { kind: "prefix" }>;
}) {
  const label = `${segment.label}/`;
  const className =
    "max-w-[160px] truncate px-1 font-mono text-xs text-foreground";

  if (segment.current) {
    return (
      <span className={className} title={segment.path}>
        {label}
      </span>
    );
  }

  return (
    <Link
      className={`${className} rounded-sm hover:bg-accent hover:text-accent-foreground`}
      href={segment.href}
      title={segment.path}
    >
      {segment.label}
    </Link>
  );
}
