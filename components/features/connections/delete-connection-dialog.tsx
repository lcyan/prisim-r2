"use client";

// components/features/connections/delete-connection-dialog.tsx
//
// Destructive confirmation per CLAUDE.md §Security Invariant #4. The user
// MUST type the connection's exact name to enable the Delete button —
// this dialog never lets a stray click destroy a connection record.
//
// State strategy: the confirmation input lives in an inner component
// rendered inside DialogContent. Radix unmounts DialogContent when
// `connection === null`, dropping the typed value naturally — no
// useEffect reset.

import { useId, useState, type FormEvent } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { useDeleteConnection } from "@/hooks/use-connections";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import type { ConnectionSummary } from "@/lib/api/types";

interface DeleteConnectionDialogProps {
  connection: ConnectionSummary | null;
  onOpenChange: (open: boolean) => void;
  /** Fired when the connection has been successfully deleted. The page
   *  uses this to clear `activeConnectionId` in the Zustand store if it
   *  was pointing at the now-gone record. */
  onDeleted?: (deletedId: string) => void;
}

export function DeleteConnectionDialog({
  connection,
  onOpenChange,
  onDeleted,
}: DeleteConnectionDialogProps) {
  return (
    <Dialog open={connection !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        {connection ? (
          <DeleteConnectionForm
            connection={connection}
            onClose={() => onOpenChange(false)}
            onDeleted={onDeleted}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeleteConnectionForm({
  connection,
  onClose,
  onDeleted,
}: {
  connection: ConnectionSummary;
  onClose: () => void;
  onDeleted?: (deletedId: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const mutation = useDeleteConnection();
  const confirmId = useId();

  // Exact-match (no trim, no case-fold) so a user accidentally pasting
  // " personal " or "Personal" doesn't enable Delete. The harshness is
  // intentional — this is a destructive op.
  const confirmed = confirmation === connection.name;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || mutation.isPending) return;
    try {
      await mutation.mutateAsync(connection.id);
      toast.success("Connection deleted", {
        description: `"${connection.name}" removed`,
      });
      onDeleted?.(connection.id);
      onClose();
    } catch (err) {
      toast.error("Couldn’t delete connection", {
        description: describeError(err),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
          <DialogTitle>Delete connection</DialogTitle>
        </div>
        <DialogDescription>
          This removes the encrypted credentials from our database. Any
          unexpired share URLs pointing at this connection will block the
          delete — remove those first.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor={confirmId}>
            Type{" "}
            <span className="font-mono text-foreground">{connection.name}</span>{" "}
            to confirm
          </Label>
          <Input
            id={confirmId}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={mutation.isPending}
            aria-invalid={
              confirmation.length > 0 && !confirmed ? true : undefined
            }
            className="font-mono"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={!confirmed || mutation.isPending}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete connection"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === ApiErrorCode.ConnectionInUse) {
      const details = err.details as { activeShares?: number } | undefined;
      const n = details?.activeShares ?? 0;
      return n > 0
        ? `Connection has ${n} active share${n === 1 ? "" : "s"}. Delete them first.`
        : "Connection has active shares. Delete them first.";
    }
    if (err.code === ApiErrorCode.NotFound) {
      return "This connection no longer exists.";
    }
    return `${err.code} — ${err.message} (request ${err.requestId})`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
