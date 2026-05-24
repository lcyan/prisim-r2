"use client";

// components/features/dashboard/bucket-switcher.tsx
//
// 顶栏左侧的 Bucket 切换器。展示当前 connection 名（只读）+ 该连接下所有 bucket
// + "在 Cloudflare 控制台新建 Bucket" 外链。
//
// 切 connection 不在这里 —— 用户去左侧"连接管理"页切换。

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Database, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnections } from "@/hooks/use-connections";
import { useBuckets } from "@/hooks/use-buckets";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { cn } from "@/lib/utils";

const T = {
  ariaLabel: "切换存储桶",
  scopeLabel: "CONN",
  none: "未选择",
  connectionHead: (name: string, masked: string) => `连接：${name} · ${masked}`,
  bucketsHead: "存储桶",
  guideNoConn: "请先去「连接管理」添加连接",
  cloudflareNew: "在 Cloudflare 控制台新建 Bucket",
} as const;

/** Mask a 32-char hex Cloudflare account ID to "abcd…wxyz" form. */
function maskAccountId(accountId: string): string {
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

export function BucketSwitcher() {
  const router = useRouter();
  const {
    activeConnectionId,
    activeBucket,
    setActiveBucket,
    setActiveConnectionId,
  } = useActiveConnectionStore();
  const { data: connections } = useConnections();
  const { data: buckets } = useBuckets(activeConnectionId);

  const conn = connections?.find((c) => c.id === activeConnectionId) ?? null;

  // 自动选择连接：当用户已经有连接但 store 里没有 active id（首次登录、清缓存、
  // 或之前激活的连接被删了），自动选第一个，避免侧栏/切换器误报"未配置"。
  useEffect(() => {
    if (!connections) return;
    const first = connections[0];
    if (!first) return;
    const stillExists =
      activeConnectionId &&
      connections.some((c) => c.id === activeConnectionId);
    if (!stillExists) {
      setActiveConnectionId(first.id);
    }
  }, [connections, activeConnectionId, setActiveConnectionId]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={T.ariaLabel}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm",
            "transition-colors hover:border-primary/40",
          )}
        >
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {T.scopeLabel}
          </span>
          <span className="h-3 w-px bg-border" aria-hidden />
          <span className="font-medium">{activeBucket ?? T.none}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {conn ? (
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {T.connectionHead(conn.name, maskAccountId(conn.accountId))}
          </DropdownMenuLabel>
        ) : (
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {T.guideNoConn}
          </DropdownMenuLabel>
        )}

        {conn ? (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {T.bucketsHead}
            </DropdownMenuLabel>
            {(buckets ?? []).map((b) => {
              const active = b.name === activeBucket;
              return (
                <DropdownMenuItem
                  key={b.name}
                  onSelect={() => {
                    setActiveBucket(b.name);
                    router.push(`/buckets/${encodeURIComponent(b.name)}`);
                  }}
                  className="flex items-center gap-3 py-1.5"
                >
                  <Database
                    className="h-3.5 w-3.5 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                  <span className="flex-1 truncate font-medium">{b.name}</span>
                  {active ? (
                    <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
                  ) : (
                    <span className="w-3.5" aria-hidden />
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a
                href="https://dash.cloudflare.com/?to=/:account/r2/overview"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm"
              >
                <ExternalLink
                  className="h-3.5 w-3.5 text-muted-foreground"
                  strokeWidth={1.5}
                />
                {T.cloudflareNew}
              </a>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
