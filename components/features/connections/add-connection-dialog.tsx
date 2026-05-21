"use client";

// components/features/connections/add-connection-dialog.tsx
//
// Modal for creating a new R2 connection. Submits to POST /api/connections
// via useCreateConnection; the server probes Cloudflare with the supplied
// keys BEFORE persisting, so a successful submit doubles as a "test &
// save" — there's no separate Test button on this dialog.
//
// Why the form lives in an inner component:
//   Radix Dialog unmounts DialogContent when `open === false`. By putting
//   the form state + mutation hook in an inner component rendered inside
//   DialogContent, closing the dialog naturally drops the state — no
//   useEffect reset, no react-hooks/set-state-in-effect violations.
//
// Error surfacing:
//   - `connection.invalid_credentials` → R2 rejected the pair (user typo
//     or expired token). Surface a specific message so the user knows to
//     re-check the token, not their app session.
//   - `validation.invalid` → unlikely if the local schema is honored, but
//     could happen if the server schema is stricter than ours; show a
//     generic field-validation message.
//   - everything else → fall through to the error code so support can
//     correlate to audit_log via the requestId in the toast.

import { useId, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
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

import { useCreateConnection } from "@/hooks/use-connections";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import type { ConnectionsCreateInput } from "@/lib/api/schemas";

interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional callback invoked with the new connection's ID after a
   *  successful create. The page uses this to auto-select the newly
   *  added connection in the active-connection store. */
  onCreated?: (connectionId: string) => void;
}

const INITIAL_FORM: ConnectionsCreateInput = {
  name: "",
  accountId: "",
  accessKeyId: "",
  secretAccessKey: "",
};

export function AddConnectionDialog({
  open,
  onOpenChange,
  onCreated,
}: AddConnectionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <AddConnectionForm
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddConnectionForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (connectionId: string) => void;
}) {
  const [form, setForm] = useState<ConnectionsCreateInput>(INITIAL_FORM);
  const mutation = useCreateConnection();
  const nameId = useId();
  const accountId = useId();
  const accessKeyIdId = useId();
  const secretId = useId();

  function update<K extends keyof ConnectionsCreateInput>(
    key: K,
    value: ConnectionsCreateInput[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Mirror the server-side ConnectionsCreateSchema. Disables the submit
  // button until shapes are plausibly valid, sparing a round-trip for a
  // guaranteed-400.
  const valid =
    form.name.trim().length > 0 &&
    form.name.trim().length <= 64 &&
    /^[a-f0-9]{32}$/.test(form.accountId.trim()) &&
    form.accessKeyId.trim().length >= 20 &&
    form.secretAccessKey.trim().length >= 40;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || mutation.isPending) return;
    try {
      const created = await mutation.mutateAsync({
        name: form.name.trim(),
        accountId: form.accountId.trim(),
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim(),
      });
      toast.success("Connection added", {
        description: `R2 probe succeeded for "${created.name}"`,
      });
      onCreated?.(created.id);
      onClose();
    } catch (err) {
      toast.error("Couldn’t add connection", {
        description: describeError(err),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add R2 connection</DialogTitle>
        <DialogDescription>
          Credentials are encrypted with AES-GCM before storage. We probe
          Cloudflare once to verify them — invalid keys are rejected before
          anything is saved.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="personal"
            required
            autoFocus
            disabled={mutation.isPending}
            maxLength={64}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={accountId}>Account ID</Label>
          <Input
            id={accountId}
            value={form.accountId}
            onChange={(e) => update("accountId", e.target.value.toLowerCase())}
            placeholder="32-char hex from the Cloudflare dashboard URL"
            required
            disabled={mutation.isPending}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={accessKeyIdId}>Access Key ID</Label>
          <Input
            id={accessKeyIdId}
            value={form.accessKeyId}
            onChange={(e) => update("accessKeyId", e.target.value)}
            placeholder="from Cloudflare → R2 → Manage API tokens"
            required
            disabled={mutation.isPending}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={secretId}>Secret Access Key</Label>
          <Input
            id={secretId}
            type="password"
            value={form.secretAccessKey}
            onChange={(e) => update("secretAccessKey", e.target.value)}
            placeholder="stored encrypted; never shown after save"
            required
            disabled={mutation.isPending}
            maxLength={256}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
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
          <Button type="submit" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Testing…
              </>
            ) : (
              "Test & save"
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === ApiErrorCode.ConnectionInvalidCredentials) {
      return "Cloudflare rejected this access key. Double-check the token has R2 read access and the account ID matches.";
    }
    if (err.code === ApiErrorCode.ValidationInvalid) {
      return "One of the fields didn’t match the expected format.";
    }
    if (err.code === ApiErrorCode.RateLimited) {
      return "Too many attempts. Wait a moment before retrying.";
    }
    return `${err.code} — ${err.message} (request ${err.requestId})`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
