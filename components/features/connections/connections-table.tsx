"use client";

// components/features/connections/connections-table.tsx
//
// Presentational table of R2 connections. Pure callback-out, no data
// fetching — the page wires this to TanStack Query mutations and Zustand
// active-connection state.
//
// Columns (matches CLAUDE.md task spec):
//   Name | Account ID | Access Key (masked) | Last Used | Actions
//
// Why "presentational only":
//   The same table is reused on the Settings/Connections page (full CRUD
//   surface) AND inside the connection switcher menu (read-only pick).
//   Pushing mutations into this component would force both call sites to
//   share a query-key choice that may not be appropriate.

import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn, formatRelative } from "@/lib/utils";
import { maskAccountId } from "@/lib/format/connections";
import type { ConnectionSummary } from "@/lib/api/types";

interface ConnectionsTableProps {
  connections: ConnectionSummary[];
  /** Currently-selected connection ID; the matching row gets the amber
   *  signal-bar accent so users can scan to it quickly. */
  activeConnectionId?: string | null;
  /** Fired when the user picks a row (clicks Name cell). Optional — Settings
   *  page passes a setter; menus may omit. */
  onSelect?: (connection: ConnectionSummary) => void;
  /** Fired when the user clicks the row's Rename action. */
  onRename: (connection: ConnectionSummary) => void;
  /** Fired when the user clicks the row's Delete action. */
  onDelete: (connection: ConnectionSummary) => void;
}

export function ConnectionsTable({
  connections,
  activeConnectionId,
  onSelect,
  onRename,
  onDelete,
}: ConnectionsTableProps) {
  if (connections.length === 0) {
    return <ConnectionsEmpty />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-secondary/30 hover:bg-secondary/30">
            <ConnectionsTableHead>Name</ConnectionsTableHead>
            <ConnectionsTableHead>Account ID</ConnectionsTableHead>
            <ConnectionsTableHead>Access Key</ConnectionsTableHead>
            <ConnectionsTableHead>Last Used</ConnectionsTableHead>
            <ConnectionsTableHead className="w-[1%] text-right">
              <span className="sr-only">Actions</span>
            </ConnectionsTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => {
            const isActive = connection.id === activeConnectionId;
            return (
              <TableRow
                key={connection.id}
                data-testid={`connection-row-${connection.id}`}
                className={cn(
                  "group relative",
                  isActive && "bg-accent/30 signal-bar",
                )}
              >
                <TableCell className="py-3 align-middle">
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(connection)}
                      className="text-left text-sm font-medium text-foreground transition-colors hover:text-primary"
                    >
                      {connection.name}
                    </button>
                  ) : (
                    <span className="text-sm font-medium text-foreground">
                      {connection.name}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {maskAccountId(connection.accountId)}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {connection.accessKeyMasked}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {connection.lastUsedAt
                    ? formatRelative(new Date(connection.lastUsedAt))
                    : "never"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Rename ${connection.name}`}
                      onClick={() => onRename(connection)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${connection.name}`}
                      onClick={() => onDelete(connection)}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function ConnectionsTableHead({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TableHead
      className={cn(
        "h-9 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

function ConnectionsEmpty() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <p className="font-display text-base font-medium text-foreground">
        No connections yet
      </p>
      <p className="mt-1 max-w-md text-balance text-sm text-muted-foreground">
        Add a Cloudflare R2 access token to start browsing buckets. Keys are
        encrypted at rest with AES-GCM and never leave the server in plaintext.
      </p>
    </div>
  );
}
