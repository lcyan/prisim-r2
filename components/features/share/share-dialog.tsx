"use client";

// components/features/share/share-dialog.tsx
//
// Mint-a-share-link dialog. Three stages in one Dialog:
//
//   1. Pre-mint: a 1h / 1d / 7d radio group + Create button.
//   2. Pending:  spinner while POST /api/share/create runs.
//   3. Post-mint: read-only URL + Copy button + live expiry countdown.
//
// State lives entirely in this component (no Zustand): the dialog is
// short-lived, the URL never escapes this render tree, and Radix unmounts
// DialogContent on close — so the URL is dropped from React state the
// instant the user clicks away. The page surface (object-table row) only
// passes in the (cid, bucket, key) triple.
//
// Why we don't persist the URL anywhere in client state:
//   It's a bearer credential for the object. Stuffing it into a Zustand
//   store would broaden the surface area for accidental serialization
//   (devtools, persistMiddleware) without buying any UX. The user can
//   re-open the dialog and mint a new URL if they lost the previous one.

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Loader2, Share2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { useCreateShare } from "@/hooks/use-shares";
import {
  SHARE_TTL_SECONDS,
  type ShareTtlSeconds,
} from "@/lib/api/schemas";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { formatRemaining } from "@/components/features/share/format-remaining";

const T = {
  ttl1h: "1 小时",
  ttl1hHint: "短期有效",
  ttl1d: "1 天",
  ttl1dHint: "常用时长",
  ttl7d: "7 天",
  ttl7dHint: "最长时长",
  shareTitle: "分享对象",
  shareDescBefore: "为 ",
  shareDescAfter: " 生成一个 presigned 链接，任何拥有该 URL 的人都能下载。链接在过期前无法撤销。",
  ttlLabel: "链接有效期",
  cancel: "取消",
  creating: "正在创建…",
  create: "创建链接",
  readyTitle: "分享链接已生成",
  readyDescBefore: "任何拥有此链接的人都能下载 ",
  readyDescAfter: " 直到链接过期。该 URL 仅展示一次，请立即复制。",
  presignedUrl: "Presigned URL",
  copyAria: "复制链接",
  urlAria: "Presigned 分享链接",
  done: "完成",
  expired: "已过期",
  expiresIn: "剩余",
  toastCreateFailed: "无法创建分享链接",
  toastCopyFailed: "复制失败，请手动从输入框复制。",
  errTooMany: "分享请求过多。请稍候再试。",
  errNotFound: "找不到连接。请到「连接管理」重新添加。",
  errValidation: "请选择 1 小时 / 1 天 / 7 天 之一。",
  errUnknown: "未知错误",
} as const;

/** TTL option metadata. Keys are the literal ttlSeconds values that the
 *  server's Zod schema accepts — anything outside this list rejects at
 *  the boundary, so we hardcode the (value, label) pairs here. */
const TTL_OPTIONS: ReadonlyArray<{
  value: ShareTtlSeconds;
  label: string;
  description: string;
}> = [
  { value: 3600, label: T.ttl1h, description: T.ttl1hHint },
  { value: 86400, label: T.ttl1d, description: T.ttl1dHint },
  { value: 604800, label: T.ttl7d, description: T.ttl7dHint },
] as const;

export interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cid: string;
  bucket: string;
  /** Full R2 key. Must be a file (not a folder marker). The caller is
   *  expected to filter folder rows out — the schema rejects "/"-leading
   *  keys server-side. */
  objectKey: string;
}

export function ShareDialog(props: ShareDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        {props.open ? (
          // Mount the form ONLY when open so Radix's close-time unmount
          // wipes the URL from React state without a manual reset effect.
          <ShareForm {...props} onClose={() => props.onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({
  cid,
  bucket,
  objectKey,
  onClose,
}: ShareDialogProps & { onClose: () => void }) {
  // Default to "1 day" — the brief's middle option matches typical "send
  // someone a file" UX; 1h is too short to share over email, 7d is the
  // long-lived case that the user opts into deliberately.
  const [ttlSeconds, setTtlSeconds] = useState<ShareTtlSeconds>(86400);
  const [result, setResult] = useState<{ url: string; expiresAt: number } | null>(
    null,
  );
  const mutation = useCreateShare();

  async function handleCreate() {
    if (mutation.isPending || result) return;
    try {
      const res = await mutation.mutateAsync({
        cid,
        bucket,
        key: objectKey,
        ttlSeconds,
      });
      setResult({ url: res.url, expiresAt: res.expiresAt });
    } catch (err) {
      toast.error(T.toastCreateFailed, {
        description: describeError(err),
      });
    }
  }

  // Post-mint surface.
  if (result) {
    return (
      <PostMintView
        url={result.url}
        expiresAt={result.expiresAt}
        objectKey={objectKey}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-primary">
            <Share2 className="h-3.5 w-3.5" />
          </span>
          <DialogTitle>{T.shareTitle}</DialogTitle>
        </div>
        <DialogDescription>
          {T.shareDescBefore}
          <span className="font-mono text-foreground">{objectKey}</span>
          {T.shareDescAfter}
        </DialogDescription>
      </DialogHeader>

      <fieldset className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {T.ttlLabel}
        </Label>
        <div className="grid grid-cols-3 gap-2">
          {TTL_OPTIONS.map((opt) => {
            const selected = ttlSeconds === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTtlSeconds(opt.value)}
                disabled={mutation.isPending}
                aria-pressed={selected}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  selected
                    ? "border-primary bg-primary/[0.06]"
                    : "border-border hover:border-foreground/30",
                )}
              >
                <span className="font-mono text-sm text-foreground">
                  {opt.label}
                </span>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={mutation.isPending}
        >
          {T.cancel}
        </Button>
        <Button
          type="button"
          onClick={handleCreate}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {T.creating}
            </>
          ) : (
            T.create
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Renders the "URL ready, copy it now" payload. Extracted + exported so
 * the /shares page can reuse it for the re-mint flow without duplicating
 * the copy affordance, expiry countdown, and the "shown only here" warning.
 */
export function PostMintView({
  url,
  expiresAt,
  objectKey,
  onClose,
}: {
  url: string;
  expiresAt: number;
  objectKey: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Reset the affordance after 2s so the user can copy again if needed.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(T.toastCopyFailed);
    }
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" />
          </span>
          <DialogTitle>{T.readyTitle}</DialogTitle>
        </div>
        <DialogDescription>
          {T.readyDescBefore}
          <span className="font-mono text-foreground">{objectKey}</span>
          {T.readyDescAfter}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {T.presignedUrl}
        </Label>
        <div className="flex items-stretch gap-1.5">
          <input
            readOnly
            value={url}
            // Select-all on focus is the standard affordance for one-shot
            // copy fields — saves a triple-click for a long URL.
            onFocus={(e) => e.currentTarget.select()}
            aria-label={T.urlAria}
            className="flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-foreground/40"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleCopy}
            aria-label={T.copyAria}
            className="px-3"
          >
            {copied ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <ExpiryCountdown expiresAt={expiresAt} />

      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {T.done}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Live "expires in …" indicator. Updates every second while mounted; the
 * Radix portal unmounts this on close, so there's no manual cleanup beyond
 * the useEffect return value.
 *
 * Exported via prop for tests that want to assert the formatted string
 * without rendering React.
 */
export function ExpiryCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const label = useMemo(
    () => formatRemaining(Math.max(0, expiresAt - now)),
    [expiresAt, now],
  );
  const expired = expiresAt <= now;

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border px-3 py-2 font-mono text-xs",
        expired
          ? "border-destructive/30 bg-destructive/[0.05] text-destructive"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
      aria-live="polite"
    >
      <span className="uppercase tracking-wider text-[10px]">
        {expired ? T.expired : T.expiresIn}
      </span>
      <span className="text-foreground" data-testid="share-countdown">
        {label}
      </span>
    </div>
  );
}

/**
 * Format a duration (ms) as `Nd HH:MM:SS` / `HH:MM:SS` / `MM:SS`. See the
 * standalone `format-remaining.ts` for the implementation — re-exported
 * here so existing imports of this component continue to resolve.
 */
export { formatRemaining };

/** ApiClientError → toast description. Branch on `code` so future status
 *  renames don't silently regress the messaging. */
function describeError(err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case ApiErrorCode.AuthUnauthorized:
        return `${err.message} (request ${err.requestId})`;
      case ApiErrorCode.RateLimited:
        return T.errTooMany;
      case ApiErrorCode.NotFound:
        return T.errNotFound;
      case ApiErrorCode.ValidationInvalid:
        return T.errValidation;
      default:
        return `${err.code} — ${err.message} (request ${err.requestId})`;
    }
  }
  if (err instanceof Error) return err.message;
  return T.errUnknown;
}

// Reference SHARE_TTL_SECONDS so an accidental drift between the schema's
// closed set and TTL_OPTIONS shows up as a TS error (the const tuple has
// the same length and order as TTL_OPTIONS). No runtime cost.
const _SHARE_TTL_CHECK: typeof SHARE_TTL_SECONDS = SHARE_TTL_SECONDS;
void _SHARE_TTL_CHECK;
