"use client";

// components/layout/topbar-connection-popover.tsx
//
// 顶栏面包屑首段 "connection" 的 popover trigger。
//
// 注意:此文件与 components/features/connections/connection-switcher.tsx
// 不是同一个组件 —— 后者是预登陆 / /connections 页用的"新建连接"对话框组合;
// 本组件只是顶栏的"切换 / 跳转新建"入口。

import Link from "next/link";
import { Check, ChevronDown, Plug, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useConnections } from "@/hooks/use-connections";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { cn } from "@/lib/utils";

const T = {
  pickPrompt: "选择连接",
  manage: "管理连接",
  add: "新建连接",
  active: "当前连接",
} as const;

export function TopbarConnectionPopover() {
  const { data: connections } = useConnections();
  const { activeConnectionId: activeId, setActiveConnectionId: setActive } =
    useActiveConnectionStore();

  const active = connections?.find((c) => c.id === activeId) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
        <Plug
          className="h-3.5 w-3.5 text-muted-foreground"
          strokeWidth={1.75}
        />
        <span
          className={cn(
            "max-w-[160px] truncate",
            !active && "text-muted-foreground",
          )}
        >
          {active?.name ?? T.pickPrompt}
        </span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>{T.active}</DropdownMenuLabel>
        {(connections ?? []).map((conn) => (
          <DropdownMenuItem
            key={conn.id}
            onSelect={() => setActive(conn.id)}
            className="flex items-center justify-between"
          >
            <span className="truncate">{conn.name}</span>
            {conn.id === activeId ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="p-0">
          <Link
            href="/connections"
            className="flex w-full items-center gap-2 px-2 py-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {T.add}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
