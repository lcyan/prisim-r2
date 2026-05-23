"use client";

// app/(dashboard)/shares/page.tsx
//
// /shares — list active share records for the current user. Each row
// shows bucket / key / created / expiry + a Delete button. Deleting a
// row removes the bookkeeping record only — the presigned URL stays
// usable until its upstream expiry, which is why the page header carries
// a prominent warning.
//
// The listing is cursor-paginated via useInfiniteQuery, identical in
// shape to the bucket browser. Filtering of expired rows is done
// server-side (WHERE expires_at > now()); the client just renders what
// it gets.

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Eye,
  Loader2,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteShare, useRevealShare, useShares } from "@/hooks/use-shares";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import { formatRelative } from "@/lib/utils";
import { formatRemaining } from "@/components/features/share/format-remaining";
import { PostMintView } from "@/components/features/share/share-dialog";
import type { ShareSummary } from "@/lib/api/types";

export default function SharesPage() {
  const {
    data,
    isPending,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useShares();

  // Flatten pages into a single list. We never sort client-side — the
  // server already returns newest-first ordered by (createdAt DESC, id DESC).
  const rows: ShareSummary[] = data
    ? data.pages.flatMap((p) => p.items)
    : [];

  // Pending deletion target. Single-row only (no bulk-delete for shares),
  // so this is a string | null rather than a Set.
  const [pendingDelete, setPendingDelete] = useState<ShareSummary | null>(null);

  // Re-mint flow state. `revealed` holds the URL + expiry returned by the
  // server after a successful POST /api/share/:id/reveal; rendering it
  // opens the URL-ready dialog. `revealing` is the row id currently
  // in-flight so we can show a spinner on just one row instead of locking
  // the whole table during the round-trip.
  const revealMutation = useRevealShare();
  const [revealed, setRevealed] = useState<
    { url: string; expiresAt: number; objectKey: string } | null
  >(null);
  const [revealingId, setRevealingId] = useState<string | null>(null);

  async function handleReveal(row: ShareSummary) {
    if (revealingId) return;
    setRevealingId(row.id);
    try {
      const res = await revealMutation.mutateAsync(row.id);
      setRevealed({
        url: res.url,
        expiresAt: res.expiresAt,
        objectKey: row.key,
      });
    } catch (err) {
      toast.error("Couldn’t reveal link", { description: describeError(err) });
      // If the row 404'd, the listing is stale (expired or deleted out of
      // band) — refresh so the user can re-orient.
      if (err instanceof ApiClientError && err.code === ApiErrorCode.NotFound) {
        void refetch();
      }
    } finally {
      setRevealingId(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <Header />
      <WarningBanner />

      <div className="flex-1 overflow-auto rounded-md border border-border bg-card">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
            <tr className="h-9">
              <Th className="pl-4">Object</Th>
              <Th className="w-32">Created</Th>
              <Th className="w-40">Expires in</Th>
              <Th className="w-44 pr-4 text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            <Body
              isPending={isPending}
              isError={isError}
              errorMessage={error?.message ?? null}
              rows={rows}
              revealingId={revealingId}
              onRetry={() => void refetch()}
              onReveal={(row) => void handleReveal(row)}
              onDelete={(row) => setPendingDelete(row)}
            />
          </tbody>
        </table>

        {hasNextPage ? (
          <div className="flex justify-center py-6">
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-4 font-mono text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetchingNextPage ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </button>
          </div>
        ) : null}
      </div>

      <RevealedShareDialog
        revealed={revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
      />

      <DeleteShareDialog
        share={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */

function Header() {
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shares</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Active presigned download links you’ve generated.
        </p>
      </div>
    </div>
  );
}

/**
 * Top-of-page warning. CLAUDE.md / task brief: deleting the bookkeeping
 * row does NOT revoke the URL — the user must know this before they
 * assume "delete = revoke". Render it as a banner (not a toast) so it's
 * always visible on the page, not just at action time.
 */
function WarningBanner() {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div>
        <p className="font-medium text-foreground">
          Deleting a record does NOT invalidate the URL.
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          URL 实际仍可用直到过期时间。Removing the row only hides it from this
          list — anyone who already has the URL can keep using it until it
          expires upstream.
        </p>
      </div>
    </div>
  );
}

function Body({
  isPending,
  isError,
  errorMessage,
  rows,
  revealingId,
  onRetry,
  onReveal,
  onDelete,
}: {
  isPending: boolean;
  isError: boolean;
  errorMessage: string | null;
  rows: ShareSummary[];
  revealingId: string | null;
  onRetry: () => void;
  onReveal: (row: ShareSummary) => void;
  onDelete: (row: ShareSummary) => void;
}) {
  if (isError) {
    return (
      <tr>
        <td colSpan={4} className="px-6 py-16 text-center">
          <AlertTriangle
            className="mx-auto h-5 w-5 text-destructive"
            strokeWidth={1.5}
          />
          <p className="mt-3 text-sm text-destructive">
            {errorMessage ?? "Couldn’t load shares."}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            Retry
          </button>
        </td>
      </tr>
    );
  }

  if (isPending) {
    return (
      <tr>
        <td colSpan={4} className="px-6 py-16 text-center">
          <Loader2
            className="mx-auto h-5 w-5 animate-spin text-muted-foreground"
            strokeWidth={1.5}
          />
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Loading…
          </p>
        </td>
      </tr>
    );
  }

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={4} className="px-6 py-20 text-center">
          <p className="font-display text-lg italic text-muted-foreground">
            No active share links.
          </p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Open a bucket and click the Share button on a file to mint one.
          </p>
        </td>
      </tr>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          isRevealing={revealingId === row.id}
          onReveal={onReveal}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function Row({
  row,
  isRevealing,
  onReveal,
  onDelete,
}: {
  row: ShareSummary;
  isRevealing: boolean;
  onReveal: (row: ShareSummary) => void;
  onDelete: (row: ShareSummary) => void;
}) {
  return (
    <tr className="group h-12 border-b border-border/60 transition-colors hover:bg-accent/40">
      <td className="pl-4">
        <div className="flex flex-col gap-0.5">
          <span className="truncate font-mono text-xs text-foreground" title={row.key}>
            {row.key}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {row.bucket}
          </span>
        </div>
      </td>
      <td className="px-2 font-mono text-xs text-muted-foreground">
        {formatRelative(new Date(row.createdAt))}
      </td>
      <td className="px-2 font-mono text-xs">
        <ExpiryCell expiresAt={row.expiresAt} />
      </td>
      <td className="pr-4 text-right">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onReveal(row)}
            disabled={isRevealing}
            aria-label="Show link"
            title="Re-mint a presigned URL valid until this share's expiry"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRevealing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            Show link
          </button>
          <button
            type="button"
            onClick={() => onDelete(row)}
            aria-label="Delete share record"
            title="Delete record (URL remains valid until expiry)"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Per-row expiry indicator. Polls Date.now() every 30s while mounted —
 * the page can carry hundreds of rows, and a 1Hz tick (like the dialog's)
 * would hurt scroll perf. 30s is fine granularity for a list view: the
 * user notices the "expires in N hours" digit changing, not the seconds.
 */
function ExpiryCell({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const remaining = expiresAt - now;
  const expired = remaining <= 0;
  return (
    <span
      className={
        expired
          ? "text-destructive"
          : remaining < 3_600_000
            ? "text-amber-600"
            : "text-muted-foreground"
      }
    >
      <Clock className="mr-1 inline h-3 w-3 align-text-bottom" />
      {expired ? "Expired" : formatRemaining(remaining)}
    </span>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={
        "px-2 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground " +
        (className ?? "")
      }
    >
      {children}
    </th>
  );
}

/**
 * Dialog that surfaces the URL returned by POST /api/share/:id/reveal.
 * Reuses PostMintView so the affordances (copy button, expiry countdown,
 * "only shown here" warning) are identical to the create flow.
 */
function RevealedShareDialog({
  revealed,
  onOpenChange,
}: {
  revealed: { url: string; expiresAt: number; objectKey: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={revealed !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        {revealed ? (
          <PostMintView
            url={revealed.url}
            expiresAt={revealed.expiresAt}
            objectKey={revealed.objectKey}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeleteShareDialog({
  share,
  onOpenChange,
}: {
  share: ShareSummary | null;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useDeleteShare();

  async function handleDelete() {
    if (!share || mutation.isPending) return;
    try {
      await mutation.mutateAsync(share.id);
      toast.success("Record deleted", {
        description: "URL remains valid until expiry.",
      });
      onOpenChange(false);
    } catch (err) {
      toast.error("Couldn’t delete record", {
        description: describeError(err),
      });
    }
  }

  return (
    <Dialog
      open={share !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        {share ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-amber-500/10 text-amber-600">
                  <ShieldAlert className="h-3.5 w-3.5" />
                </span>
                <DialogTitle>Remove share record?</DialogTitle>
              </div>
              <DialogDescription>
                This drops the bookkeeping row for{" "}
                <span className="font-mono text-foreground">{share.key}</span>{" "}
                in{" "}
                <span className="font-mono text-foreground">
                  {share.bucket}
                </span>
                . The presigned URL itself is NOT revoked — it stays usable
                until {new Date(share.expiresAt).toLocaleString()}.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleDelete}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Delete record"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case ApiErrorCode.AuthUnauthorized:
        return `${err.message} (request ${err.requestId})`;
      case ApiErrorCode.NotFound:
        return "Already removed.";
      case ApiErrorCode.RateLimited:
        return "Too many requests. Wait a moment and try again.";
      default:
        return `${err.code} — ${err.message} (request ${err.requestId})`;
    }
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
