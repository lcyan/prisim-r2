"use client";

// components/features/dashboard/bucket-switcher.tsx
//
// Read-only bucket selector for the dashboard top bar. Surfaces the buckets
// visible to the currently-active R2 connection and writes the choice into
// the active-connection Zustand store so other parts of the dashboard (file
// browser, upload area, presign hook) read a single source of truth.
//
// Why dropdown-menu (radix) and not a native <select>:
//   * Matches the rest of the dashboard's interaction model — connection
//     switcher already uses a popover, the design system bundles shadcn's
//     dropdown-menu, and we get keyboard nav + focus management for free.
//   * Lets us render rich items (bucket name + relative-time created date)
//     instead of cramming everything into a single text slot.
//
// State sources:
//   * useActiveConnectionStore — for the cid (selected connection) and the
//     bucket that's already picked. Updating activeConnectionId in the
//     store automatically clears activeBucket (see stores/active-connection.ts)
//     so this component doesn't have to coordinate that on its own.
//   * useBuckets(cid) — TanStack Query: 5-min cache, disabled when cid is null.
//
// V1 scope: bucket creation / deletion is NOT supported (CLAUDE.md task spec
// + memory). The empty state links to the Cloudflare dashboard instead.

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
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
import { ApiClientError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * URL of the Cloudflare R2 dashboard, used in the empty-state helper.
 * Hard-coded because the path is stable across accounts (CF routes to the
 * authenticated user's R2 area automatically). Extracted as a constant so
 * it shows up in one place if it ever changes.
 */
const R2_DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/r2";

export interface BucketSwitcherProps {
  /** Extra classes for the trigger Button. Lets the dashboard slot the
   *  switcher into different surfaces without a wrapper element. */
  className?: string;
}

export function BucketSwitcher({ className }: BucketSwitcherProps) {
  const router = useRouter();
  const activeConnectionId = useActiveConnectionStore(
    (s) => s.activeConnectionId,
  );
  const activeBucket = useActiveConnectionStore((s) => s.activeBucket);
  const setActiveBucket = useActiveConnectionStore((s) => s.setActiveBucket);

  const {
    data: buckets,
    isPending,
    isFetching,
    isError,
    error,
    refetch,
  } = useBuckets(activeConnectionId);

  // When no connection is selected the hook stays idle (enabled=false) and
  // `isPending` is true with `data` undefined. That state is meaningless to
  // the user — show a disabled trigger that explains why instead of a
  // spinner that would never resolve.
  if (!activeConnectionId) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className={cn("gap-2", className)}
        aria-label="Pick a connection before selecting a bucket"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          No connection
        </span>
      </Button>
    );
  }

  const triggerLabel = activeBucket ?? "Select bucket";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("gap-2", className)}
          aria-label="Bucket switcher"
        >
          {isPending || isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : isError ? (
            <AlertTriangle className="h-3 w-3 text-destructive" />
          ) : null}
          <span
            className={cn(
              "max-w-[160px] truncate text-sm",
              activeBucket ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {triggerLabel}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[260px]">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Buckets
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {isPending ? (
          <BucketStateRow label="Loading buckets…" icon="spinner" />
        ) : isError ? (
          <BucketErrorRow error={error} onRetry={() => void refetch()} />
        ) : !buckets || buckets.length === 0 ? (
          <BucketEmptyRow />
        ) : (
          buckets.map((bucket) => {
            const isActive = bucket.name === activeBucket;
            return (
              <DropdownMenuItem
                key={bucket.name}
                onSelect={() => {
                  // Update the store first so other components (e.g. presign
                  // hooks) observe the new selection before the route change
                  // triggers a re-render, then jump to the object browser so
                  // the main pane actually reflects the user's choice.
                  setActiveBucket(bucket.name);
                  router.push(`/buckets/${encodeURIComponent(bucket.name)}`);
                }}
                className="flex items-start gap-2"
              >
                <Check
                  className={cn(
                    "mt-1 h-3.5 w-3.5 shrink-0",
                    isActive ? "text-primary" : "opacity-0",
                  )}
                  strokeWidth={2.5}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{bucket.name}</p>
                  {bucket.createdAt ? (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      created {new Date(bucket.createdAt).toISOString().slice(0, 10)}
                    </p>
                  ) : null}
                </div>
              </DropdownMenuItem>
            );
          })
        )}

        <DropdownMenuSeparator />
        <a
          href={R2_DASHBOARD_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          Create bucket in Cloudflare
        </a>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BucketStateRow({
  label,
  icon,
}: {
  label: string;
  icon: "spinner" | "warn";
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      {icon === "spinner" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
      )}
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function BucketErrorRow({
  error,
  onRetry,
}: {
  error: ApiClientError | Error | null;
  onRetry: () => void;
}) {
  // Surface a domain-specific hint for the two error codes the dashboard
  // can actually react to — credential rejection by R2 vs. expired session.
  // Everything else falls back to the generic message.
  const code = error instanceof ApiClientError ? error.code : null;
  const hint =
    code === "connection.invalid_credentials"
      ? "R2 rejected the saved credentials. Re-add the connection to retry."
      : code === "auth.unauthorized"
        ? "Your session expired. Sign in again."
        : error?.message ?? "Couldn’t load buckets";

  return (
    <div className="px-2 py-2">
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
          strokeWidth={2}
        />
        <p className="text-xs text-destructive">{hint}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        Retry
      </button>
    </div>
  );
}

function BucketEmptyRow() {
  return (
    <div className="px-2 py-3 text-center">
      <p className="text-sm font-medium text-foreground">No buckets yet</p>
      <p className="mt-1 max-w-[220px] text-balance text-xs text-muted-foreground">
        Create your first bucket in the Cloudflare dashboard — V1 doesn’t
        manage bucket lifecycle here.
      </p>
    </div>
  );
}
