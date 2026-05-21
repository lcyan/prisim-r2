"use client";

// app/(dashboard)/settings/connections/page.tsx
//
// Connection management page. Composes the table + three dialogs + the
// active-connection Zustand store + the TanStack Query hooks.
//
// State model:
//   * Server state (list of connections) lives in TanStack Query under
//     ['connections']; the table reads it through useConnections().
//   * Dialog visibility is plain useState — there are only three dialogs
//     and they're mutually exclusive in practice, so a store would be
//     over-engineered.
//   * activeConnectionId lives in the persisted Zustand store. The page
//     auto-selects a newly-created connection and clears the active id
//     if the user deletes the connection they were on.

import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { AddConnectionDialog } from "@/components/features/connections/add-connection-dialog";
import { ConnectionsTable } from "@/components/features/connections/connections-table";
import { DeleteConnectionDialog } from "@/components/features/connections/delete-connection-dialog";
import { RenameConnectionDialog } from "@/components/features/connections/rename-connection-dialog";

import { useConnections } from "@/hooks/use-connections";
import { useActiveConnectionStore } from "@/stores/active-connection";
import { cn } from "@/lib/utils";
import type { ConnectionSummary } from "@/lib/api/types";

export default function ConnectionsSettingsPage() {
  const { data, isPending, isError, error, refetch, isFetching } =
    useConnections();

  const [addOpen, setAddOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConnectionSummary | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ConnectionSummary | null>(
    null,
  );

  const activeConnectionId = useActiveConnectionStore(
    (s) => s.activeConnectionId,
  );
  const setActiveConnectionId = useActiveConnectionStore(
    (s) => s.setActiveConnectionId,
  );
  const clearActiveConnectionId = useActiveConnectionStore(
    (s) => s.clearActiveConnectionId,
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Settings · connections
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">
            R2 connections
          </h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            Bind one or more Cloudflare R2 API tokens. Credentials are
            encrypted at rest with AES-GCM; the dashboard never sees the
            secret after save.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refetch();
            }}
            disabled={isFetching}
            aria-label="Refresh connection list"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
            />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add connection
          </Button>
        </div>
      </header>

      {isPending ? (
        <ConnectionsLoading />
      ) : isError ? (
        <ConnectionsError
          message={error instanceof Error ? error.message : "Unknown error"}
          onRetry={() => {
            void refetch();
          }}
        />
      ) : (
        <ConnectionsTable
          connections={data}
          activeConnectionId={activeConnectionId}
          onSelect={(c) => setActiveConnectionId(c.id)}
          onRename={(c) => setRenameTarget(c)}
          onDelete={(c) => setDeleteTarget(c)}
        />
      )}

      <AddConnectionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(id) => setActiveConnectionId(id)}
      />
      <RenameConnectionDialog
        connection={renameTarget}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      />
      <DeleteConnectionDialog
        connection={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={(id) => {
          if (activeConnectionId === id) clearActiveConnectionId();
        }}
      />
    </div>
  );
}

function ConnectionsLoading() {
  // Stable skeleton — three rows so the page doesn't collapse before
  // data lands. Match the row height of ConnectionsTable so layout
  // doesn't shift on first render.
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
        >
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 w-28 animate-pulse rounded bg-muted" />
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="ml-auto h-3 w-16 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function ConnectionsError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-4">
      <div>
        <p className="text-sm font-medium text-destructive">
          Couldn’t load connections
        </p>
        <p className="mt-1 font-mono text-[10px] text-destructive/80">
          {message}
        </p>
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
