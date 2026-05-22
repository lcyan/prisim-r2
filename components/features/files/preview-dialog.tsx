"use client";

// components/features/files/preview-dialog.tsx
//
// In-app preview surface for a single R2 object. Three subviews, chosen
// by extension (see lib/files/preview.ts):
//
//   * image       → <img src={presignedUrl}>; skeleton while loading
//                    when the object is large (> PREVIEW_IMAGE_LARGE_BYTES).
//   * text        → Range-fetch first 1 MiB, decode UTF-8, render <pre>;
//                    if the object is larger, show a "first 1 MB of N MB"
//                    banner at the top.
//   * unavailable → "Preview not available for this file type" with a
//                    Download button for convenience.
//
// State stays in the component because the dialog is short-lived and
// closing it unmounts everything (Radix unmounts DialogContent), which
// drops the presigned URL out of React state without a manual reset.
// The presigned URL also lives 5 minutes — short on purpose so a stale
// URL in devtools is useless within minutes.
//
// What this component does NOT do:
//   * No syntax highlighting — V2 affordance, would drag a tokenizer
//     into the bundle. The text view is plain monospace.
//   * No iframe sandbox for HTML/PDF — would need its own CSP review
//     and same-origin handling. Defer to "Preview not available".
//   * No editing — read-only.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Download,
  Eye,
  FileQuestion,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  detectPreviewKind,
  PREVIEW_IMAGE_LARGE_BYTES,
  PREVIEW_TEXT_BYTE_CAP,
  type PreviewKind,
} from "@/lib/files/preview";
import { fetchTextHead, usePresignPreviewUrl } from "@/hooks/use-preview";
import { useDownloadObject } from "@/hooks/use-download";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import { cn, formatBytes } from "@/lib/utils";

export interface PreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cid: string;
  bucket: string;
  /** Full R2 key for the object being previewed. Folder keys (ending
   *  in '/') should never reach this component — the table only fires
   *  Preview on file rows. */
  objectKey: string;
  /** Object size in bytes, when known from the list response. Used to
   *  decide whether to render the large-image skeleton and to populate
   *  the truncation banner when totalBytes can't be parsed from the
   *  Range response. null = unknown (deep link, refetch after delete). */
  size: number | null;
}

export function PreviewDialog(props: PreviewDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[860px]">
        {props.open ? (
          // Lazy-mount the body so closing wipes per-preview state (the
          // presigned URL, the fetched text, the skeleton flag) without
          // a reset effect.
          <PreviewBody
            {...props}
            onClose={() => props.onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({
  cid,
  bucket,
  objectKey,
  size,
  onClose,
}: PreviewDialogProps & { onClose: () => void }) {
  const kind: PreviewKind = useMemo(
    () => detectPreviewKind(objectKey),
    [objectKey],
  );

  const presign = usePresignPreviewUrl();
  // Fire the presign exactly once per (cid, bucket, key) when the body
  // mounts. We don't want the mutation to retrigger on every render
  // (mutate is stable from TanStack Query but the effect's dep array
  // would still re-fire if cid/bucket/key changed — desirable behaviour
  // for the "open a different object" path).
  useEffect(() => {
    if (kind === "unavailable") return;
    presign.mutate({ cid, bucket, key: objectKey });
    // We intentionally exclude `presign` from deps — it's referentially
    // stable across renders and including it would trip eslint's
    // exhaustive-deps without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, bucket, objectKey, kind]);

  const downloadMutation = useDownloadObject();
  function handleDownload() {
    downloadMutation.mutate({ cid, bucket, key: objectKey });
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-primary">
            <Eye className="h-3.5 w-3.5" />
          </span>
          <DialogTitle className="truncate">
            {fileDisplay(objectKey)}
          </DialogTitle>
        </div>
        <DialogDescription className="font-mono text-[11px] text-muted-foreground">
          {bucket}/{objectKey}
          {size !== null ? <> · {formatBytes(size)}</> : null}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-[280px]">
        {kind === "unavailable" ? (
          <UnavailableView />
        ) : presign.isPending || !presign.data ? (
          <PresignLoadingView error={presign.error} />
        ) : kind === "image" ? (
          <ImageView
            url={presign.data.url}
            objectKey={objectKey}
            size={size}
          />
        ) : (
          // `key={url}` remounts the text view if the URL ever changes
          // mid-dialog (e.g. a presign retry). That way the effect's
          // useState initializer is the only place that ever sets the
          // "loading" phase — no setState-in-effect cascade.
          <TextView
            key={presign.data.url}
            url={presign.data.url}
            sizeHint={size}
          />
        )}
      </div>

      <DialogFooter className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          disabled={downloadMutation.isPending}
          className="text-xs"
        >
          {downloadMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          Download
        </Button>
        <Button type="button" size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function PresignLoadingView({ error }: { error: Error | null }) {
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <AlertTriangle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-foreground">Couldn’t load preview</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {describePresignError(error)}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-[280px] items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function UnavailableView() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <FileQuestion className="h-7 w-7 text-muted-foreground" />
      <p className="text-sm text-foreground">Preview not available</p>
      <p className="max-w-md text-xs text-muted-foreground">
        This file type can’t be previewed in the browser. Use the
        Download button to fetch it locally.
      </p>
    </div>
  );
}

function ImageView({
  url,
  objectKey,
  size,
}: {
  url: string;
  objectKey: string;
  size: number | null;
}) {
  // Large-image skeleton: only kept up until the <img> fires onLoad /
  // onError. We don't gate ALL images behind it because a 50 KB png on
  // localhost flashes the skeleton for one frame.
  const showSkeleton =
    size !== null && size > PREVIEW_IMAGE_LARGE_BYTES;
  const [imgState, setImgState] = useState<"loading" | "loaded" | "error">(
    showSkeleton ? "loading" : "loaded",
  );
  return (
    <div className="relative flex items-center justify-center rounded-md border border-border bg-muted/30">
      {imgState === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {imgState === "error" ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <p className="text-xs text-muted-foreground">
            Couldn’t load the image. Check the bucket’s CORS configuration.
          </p>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={objectKey}
          onLoad={() => setImgState("loaded")}
          onError={() => setImgState("error")}
          className={cn(
            "max-h-[60vh] w-auto object-contain transition-opacity",
            imgState === "loading" ? "opacity-0" : "opacity-100",
          )}
        />
      )}
    </div>
  );
}

function TextView({
  url,
  sizeHint,
}: {
  url: string;
  sizeHint: number | null;
}) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "loaded"; text: string; truncated: boolean; total: number | null }
    | { phase: "error"; message: string }
  >({ phase: "loading" });

  useEffect(() => {
    // AbortController guards against the dialog closing mid-fetch — a
    // tab-flip that loads a 1 MB log shouldn't keep the request alive.
    // Parent re-keys the component on every URL change, so the initial
    // useState already covers "reset to loading" — no setState-in-effect.
    const ac = new AbortController();
    let cancelled = false;
    fetchTextHead(url, { signal: ac.signal })
      .then((res) => {
        if (cancelled) return;
        // Prefer header-derived total; fall back to the caller's sizeHint
        // when the proxy stripped Content-Range/Content-Length.
        const total = res.totalBytes ?? sizeHint;
        // truncated may have been resolved server-side, but the hint is
        // also a signal: if we know the file is bigger than the cap and
        // the response headers were silent, mark truncated anyway.
        const truncated =
          res.truncated ||
          (total !== null && total > PREVIEW_TEXT_BYTE_CAP);
        setState({ phase: "loaded", text: res.text, truncated, total });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [url, sizeHint]);

  if (state.phase === "loading") {
    return (
      <div className="flex h-[280px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <AlertTriangle className="h-5 w-5 text-destructive" />
        <p className="text-sm text-foreground">Couldn’t load text</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {state.message}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {state.truncated ? (
        <div
          role="status"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
        >
          Showing first {formatBytes(PREVIEW_TEXT_BYTE_CAP)}
          {state.total !== null ? <> of {formatBytes(state.total)}</> : null}
          . Download for the full file.
        </div>
      ) : null}
      <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-all">
        {state.text}
      </pre>
    </div>
  );
}

function fileDisplay(key: string): string {
  return key.split("/").filter(Boolean).pop() ?? key;
}

function describePresignError(err: Error): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case ApiErrorCode.AuthUnauthorized:
        return `${err.message} (request ${err.requestId})`;
      case ApiErrorCode.RateLimited:
        return "Too many preview requests. Wait a moment and try again.";
      case ApiErrorCode.NotFound:
        return "Object not found.";
      default:
        return `${err.code} — ${err.message} (request ${err.requestId})`;
    }
  }
  return err.message;
}
