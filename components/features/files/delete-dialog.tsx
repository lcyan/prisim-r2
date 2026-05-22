"use client";

// components/features/files/delete-dialog.tsx
//
// Destructive confirmation for bulk object deletion. CLAUDE.md security
// invariant #4: every destructive op requires a typed confirmation on the
// client AND a server-verified confirmation token. This dialog handles the
// human ceremony — the HMAC token is minted in lib/api/delete-token.ts and
// transparently chained inside useDeleteObjects (prepare → confirm).
//
// Why typing the BUCKET name (not the key list, not "DELETE"):
//   The bucket name is the noun the user understands and a deliberate
//   speed-bump — Github / AWS / Cloudflare all use it for the same reason.
//   Asking the user to retype each key would be cruel for a 100-key
//   selection; "DELETE" is the GitHub-style fallback but doesn't scope the
//   confirmation to the right resource.
//
// Why we show up to 20 keys and summarize the rest:
//   The user needs to recognize what they're about to lose, but rendering
//   100 rows in a Radix dialog is jank. 20 is the table page's first batch
//   roughly — enough to spot a typo in a multi-select, short enough to fit
//   without scrolling.
//
// State lifecycle:
//   Like delete-connection-dialog.tsx, we render the form ONLY when the
//   outer Dialog is open. Radix unmounts DialogContent on close so the
//   typed input resets without a manual reset effect.

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

import { useDeleteObjects } from "@/hooks/use-delete-objects";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";

/** Max keys rendered in the dialog body. Anything beyond this collapses
 *  into a "…及 N 个其他" trailer. Exported so unit tests can assert the
 *  truncation logic without coupling to a magic number. */
export const DELETE_DIALOG_VISIBLE_KEYS = 20;

export interface DeleteDialogProps {
  /** When non-null, the dialog is open and shows these keys. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cid: string;
  bucket: string;
  /** Current listing prefix — passed through to the hook so the right
   *  TanStack Query cache entry gets invalidated on success. */
  prefix: string;
  /** Full R2 keys. Folder rows (trailing "/") MUST be filtered out by
   *  the caller — V1 delete is non-recursive. */
  keys: string[];
  /** Fired after R2 confirms the deletion (whether or not partial errors
   *  occurred). Lets the page clear cross-page row selection. */
  onDeleted?: (deletedKeys: string[]) => void;
}

export function DeleteDialog(props: DeleteDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        {props.open ? (
          // Mount the form ONLY when open — Radix unmounts on close so
          // the typed input resets implicitly. Cheaper than a useEffect
          // chain to wipe state.
          <DeleteForm {...props} onClose={() => props.onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeleteForm({
  cid,
  bucket,
  prefix,
  keys,
  onDeleted,
  onClose,
}: DeleteDialogProps & { onClose: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const mutation = useDeleteObjects();
  const confirmId = useId();

  // Exact-match (no trim, no case-fold) — same harshness as the connection
  // delete dialog. The user must type EXACTLY the bucket name shown.
  const confirmed = confirmation === bucket;
  const visibleKeys = keys.slice(0, DELETE_DIALOG_VISIBLE_KEYS);
  const overflow = Math.max(0, keys.length - DELETE_DIALOG_VISIBLE_KEYS);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || mutation.isPending || keys.length === 0) return;
    try {
      const result = await mutation.mutateAsync({
        cid,
        bucket,
        prefix,
        keys,
      });
      // Partial-failure path: HTTP 200 with non-empty errors. Surface a
      // distinct toast so the user knows some keys survived; the listing
      // refresh will reveal which ones.
      if (result.errors.length > 0) {
        const successCount = result.deleted.length;
        const failCount = result.errors.length;
        toast.warning(
          `Deleted ${successCount}, ${failCount} failed`,
          {
            description: result.errors
              .slice(0, 3)
              .map(
                (e) =>
                  `${e.key ?? "?"}: ${e.code ?? "Error"}${e.message ? ` — ${e.message}` : ""}`,
              )
              .join("\n"),
          },
        );
      } else {
        toast.success(
          result.deleted.length === 1
            ? "1 object deleted"
            : `${result.deleted.length} objects deleted`,
        );
      }
      onDeleted?.(result.deleted);
      onClose();
    } catch (err) {
      toast.error("Couldn’t delete objects", {
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
          <DialogTitle>
            {keys.length === 1
              ? "Delete object"
              : `Delete ${keys.length} objects`}
          </DialogTitle>
        </div>
        <DialogDescription>
          This permanently removes the selected objects from{" "}
          <span className="font-mono text-foreground">{bucket}</span>. R2
          does not version, so the data cannot be recovered.
        </DialogDescription>
      </DialogHeader>

      <div
        className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs"
        // Programmatic scroll region for the key list. role + label give
        // screen readers a hook so the list isn't lost in the visual
        // hierarchy.
        role="region"
        aria-label="Objects to delete"
      >
        <ul className="space-y-0.5">
          {visibleKeys.map((k) => (
            <li
              key={k}
              className="truncate text-muted-foreground"
              title={k}
            >
              {k}
            </li>
          ))}
        </ul>
        {overflow > 0 ? (
          <p className="mt-1 text-[11px] italic text-muted-foreground">
            …及 {overflow} 个其他
          </p>
        ) : null}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor={confirmId}>
            Type bucket name{" "}
            <span className="font-mono text-foreground">{bucket}</span>{" "}
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
            disabled={!confirmed || mutation.isPending || keys.length === 0}
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Deleting…
              </>
            ) : keys.length === 1 ? (
              "Delete object"
            ) : (
              `Delete ${keys.length} objects`
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** Map known ApiErrorCode values to one-line toast descriptions. Branch on
 *  `code` (not status) so renames of an HTTP status don't silently regress. */
function describeError(err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case ApiErrorCode.ConfirmationRequired:
        return "Confirmation expired. Please confirm again.";
      case ApiErrorCode.AuthUnauthorized:
        return `${err.message} (request ${err.requestId})`;
      case ApiErrorCode.RateLimited:
        return "Too many delete requests. Wait a moment and try again.";
      case ApiErrorCode.NotFound:
        return "Connection not found. Re-add it from Settings → Connections.";
      default:
        return `${err.code} — ${err.message} (request ${err.requestId})`;
    }
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
