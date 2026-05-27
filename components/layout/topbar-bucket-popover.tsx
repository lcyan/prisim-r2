"use client";

// components/layout/topbar-bucket-popover.tsx
//
// 顶栏面包屑 bucket 段:显示当前 bucket 名,点击展开同 connection 下所有
// bucket 列表 + "查看全部 bucket"链接(跳 /buckets)。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Database, ListIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";

const T = {
  current: "当前 Bucket",
  viewAll: "查看全部 Bucket",
  empty: "暂无 Bucket",
} as const;

interface TopbarBucketPopoverProps {
  currentBucket: string;
}

export function TopbarBucketPopover({
  currentBucket,
}: TopbarBucketPopoverProps) {
  const router = useRouter();
  // Use destructure (not selector) so the test's mockReturnValue works.
  const { activeConnectionId: activeId } = useActiveConnectionStore();
  const { data: buckets } = useBuckets(activeId);

  function goto(bucket: string) {
    router.push(`/buckets/${encodeURIComponent(bucket)}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
        <Database
          className="h-3.5 w-3.5 text-muted-foreground"
          strokeWidth={1.75}
        />
        <span className="max-w-[180px] truncate">{currentBucket}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>{T.current}</DropdownMenuLabel>
        {(buckets ?? []).length === 0 ? (
          <DropdownMenuItem disabled>{T.empty}</DropdownMenuItem>
        ) : (
          (buckets ?? []).map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => goto(b.name)}
              className="flex items-center justify-between"
            >
              <span className="truncate font-mono text-xs">{b.name}</span>
              {b.name === currentBucket ? (
                <Check className="h-3.5 w-3.5" />
              ) : null}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="p-0">
          <Link
            href="/buckets"
            className="flex w-full items-center gap-2 px-2 py-1.5"
          >
            <ListIcon className="h-3.5 w-3.5" />
            {T.viewAll}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
