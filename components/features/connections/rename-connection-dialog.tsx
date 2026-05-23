"use client";

// components/features/connections/rename-connection-dialog.tsx
//
// PATCH /api/connections/[id] is "rename only" by design — the server
// schema rejects any other field. So this dialog is intentionally minimal:
// one input, submit + cancel, error toast on failure.
//
// State strategy: the form lives in an inner component rendered inside
// DialogContent. When `connection === null` Radix unmounts the content,
// dropping the form state — no useEffect reset needed.

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

import { useUpdateConnection } from "@/hooks/use-connections";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import type { ConnectionSummary } from "@/lib/api/types";

const T = {
  title: "重命名连接",
  desc: "仅修改显示名，不会重新校验凭据。",
  nameLabel: "名称",
  namePlaceholder: "给这个连接起个名字",
  cancel: "取消",
  save: "保存",
  saving: "正在保存…",
  successToast: "已重命名",
  successDesc: (oldName: string, newName: string) =>
    `「${oldName}」→「${newName}」`,
  failureToast: "重命名失败",
  errNotFound: "该连接已不存在，请刷新页面。",
  errUnknown: "未知错误",
} as const;

interface RenameConnectionDialogProps {
  /** The connection being renamed. `null` collapses the dialog (this is
   *  how the parent page closes it without keeping a separate boolean —
   *  setting selected to null clears the modal and its target in one go). */
  connection: ConnectionSummary | null;
  onOpenChange: (open: boolean) => void;
}

export function RenameConnectionDialog({
  connection,
  onOpenChange,
}: RenameConnectionDialogProps) {
  return (
    <Dialog open={connection !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        {connection ? (
          <RenameConnectionForm
            connection={connection}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameConnectionForm({
  connection,
  onClose,
}: {
  connection: ConnectionSummary;
  onClose: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const mutation = useUpdateConnection();
  const nameId = useId();

  const trimmed = name.trim();
  const valid =
    trimmed.length > 0 && trimmed.length <= 64 && trimmed !== connection.name;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || mutation.isPending) return;
    try {
      await mutation.mutateAsync({ id: connection.id, name: trimmed });
      toast.success(T.successToast, {
        description: T.successDesc(connection.name, trimmed),
      });
      onClose();
    } catch (err) {
      toast.error(T.failureToast, {
        description: describeError(err),
      });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{T.title}</DialogTitle>
        <DialogDescription>
          {T.desc}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor={nameId}>{T.nameLabel}</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            disabled={mutation.isPending}
            maxLength={64}
            placeholder={T.namePlaceholder}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            {T.cancel}
          </Button>
          <Button type="submit" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {T.saving}
              </>
            ) : (
              T.save
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === ApiErrorCode.NotFound) {
      return T.errNotFound;
    }
    return `${err.code} — ${err.message} (request ${err.requestId})`;
  }
  if (err instanceof Error) return err.message;
  return T.errUnknown;
}
