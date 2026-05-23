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

const T = {
  title: "新建连接",
  desc: "添加一个 Cloudflare R2 账号到本系统。Secret 提交后即 AES-GCM 加密，不再明文显示。",
  nameLabel: "名称",
  namePlaceholder: "给这个连接起个名字",
  accountIdLabel: "Account ID",
  accountIdPlaceholder: "从 Cloudflare URL 复制 32 位 hex",
  accessKeyIdLabel: "Access Key ID",
  accessKeyIdPlaceholder: "Cloudflare → R2 → 管理 API 令牌",
  secretLabel: "Secret Access Key",
  secretPlaceholder: "加密保存，提交后不再可见",
  cancel: "取消",
  submit: "添加",
  submitting: "正在添加…",
  successToast: "连接已添加",
  successDesc: (name: string) => `R2 连通性校验成功：「${name}」`,
  failureToast: "添加失败",
  errInvalidCreds: "Cloudflare 拒绝了该 Access Key，请检查 Token 是否具备 R2 读取权限，以及 Account ID 是否匹配。",
  errValidation: "有字段不符合预期格式。",
  errRateLimited: "尝试过于频繁，请稍后再试。",
  errUnknown: "未知错误",
} as const;

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
      toast.success(T.successToast, {
        description: T.successDesc(created.name),
      });
      onCreated?.(created.id);
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
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder={T.namePlaceholder}
            required
            autoFocus
            disabled={mutation.isPending}
            maxLength={64}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={accountId}>{T.accountIdLabel}</Label>
          <Input
            id={accountId}
            value={form.accountId}
            onChange={(e) => update("accountId", e.target.value.toLowerCase())}
            placeholder={T.accountIdPlaceholder}
            required
            disabled={mutation.isPending}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={accessKeyIdId}>{T.accessKeyIdLabel}</Label>
          <Input
            id={accessKeyIdId}
            value={form.accessKeyId}
            onChange={(e) => update("accessKeyId", e.target.value)}
            placeholder={T.accessKeyIdPlaceholder}
            required
            disabled={mutation.isPending}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={secretId}>{T.secretLabel}</Label>
          <Input
            id={secretId}
            type="password"
            value={form.secretAccessKey}
            onChange={(e) => update("secretAccessKey", e.target.value)}
            placeholder={T.secretPlaceholder}
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
            {T.cancel}
          </Button>
          <Button type="submit" disabled={!valid || mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {T.submitting}
              </>
            ) : (
              T.submit
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
      return T.errInvalidCreds;
    }
    if (err.code === ApiErrorCode.ValidationInvalid) {
      return T.errValidation;
    }
    if (err.code === ApiErrorCode.RateLimited) {
      return T.errRateLimited;
    }
    return `${err.code} — ${err.message} (request ${err.requestId})`;
  }
  if (err instanceof Error) return err.message;
  return T.errUnknown;
}
