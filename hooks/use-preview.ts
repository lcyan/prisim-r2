// hooks/use-preview.ts
//
// Hook + helpers behind PreviewDialog. Two concerns:
//
//   1. Mint a short-lived presigned GET (op="get", ttl=5min) — the URL
//      becomes the <img src> for images, or the input to the Range
//      fetch for text. Mirrors use-download.ts: extracted pure helper
//      so vitest can pin the wire shape without a React tree.
//   2. Fetch the first PREVIEW_TEXT_BYTE_CAP bytes of a text object via
//      Range header, decode UTF-8, and report whether the file was
//      truncated. We use the response's Content-Range/Content-Length
//      to learn the true size — preferable to relying on the LIST size
//      that the caller may not know (e.g. a key reached via deep link).
//
// What this hook does NOT do:
//   * No retries — same reasoning as use-download.ts. A failed presign
//     would write a second audit row, and the user can click again.
//   * No caching of the URL across renders — TTL is 5 min and a closed
//     dialog has no use for a stale URL. useMutation matches the
//     "trigger, observe, never auto-refetch" shape.
//   * No image preloading — <img src> handles that natively. The UI
//     uses onLoad/onError to clear the large-file skeleton.

import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import {
  PREVIEW_PRESIGN_TTL_SECONDS,
  PREVIEW_TEXT_BYTE_CAP,
} from "@/lib/files/preview";
import type { R2PresignResponse } from "@/lib/api/types";

/** Re-export so callers (PreviewDialog, tests) can refer to the same
 *  constant when reasoning about the preview URL's lifetime. */
export const PREVIEW_PRESIGN_TTL = PREVIEW_PRESIGN_TTL_SECONDS;

export interface PreviewPresignInput {
  cid: string;
  bucket: string;
  key: string;
}

/** POST /api/r2/presign body builder for the preview flow. Same route
 *  as the download path; the smaller TTL is the only difference. */
export function requestPreviewPresignedUrl(
  input: PreviewPresignInput,
): Promise<R2PresignResponse> {
  return apiFetch<R2PresignResponse>("/api/r2/presign", {
    method: "POST",
    json: {
      op: "get",
      cid: input.cid,
      bucket: input.bucket,
      key: input.key,
      ttl: PREVIEW_PRESIGN_TTL,
    },
  });
}

export interface TextPreviewResult {
  /** UTF-8 decoded body of the first PREVIEW_TEXT_BYTE_CAP bytes (or the
   *  whole object when smaller). Decoder replaces invalid sequences with
   *  the U+FFFD replacement character; do NOT throw on partial multibyte
   *  runs at the tail. */
  text: string;
  /** True when the object is larger than PREVIEW_TEXT_BYTE_CAP and the
   *  text above is only the head. Drives the banner in PreviewDialog. */
  truncated: boolean;
  /** Total object size in bytes, when discoverable from the response
   *  (Content-Range header on a 206, or Content-Length on a 200). null
   *  when neither header is present (some R2-compatible proxies strip
   *  them); the UI still renders the truncation banner via `truncated`. */
  totalBytes: number | null;
}

/**
 * Parse "bytes 0-1048575/52428800" → 52_428_800. R2 always returns the
 * total size in the slash-suffix on a 206; a "*" suffix means unknown
 * (some implementations) and we return null in that case.
 *
 * Exported so the vitest spec can pin the parsing rules without
 * exercising the full Range fetch path.
 */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  // Header form: "bytes <start>-<end>/<total>" (RFC 7233 §4.2). Be lax
  // about the "bytes " prefix — some proxies normalize whitespace.
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const totalRaw = header.slice(slash + 1).trim();
  if (totalRaw === "*" || totalRaw === "") return null;
  const total = Number(totalRaw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * Fetch the first PREVIEW_TEXT_BYTE_CAP bytes of an object via a Range
 * request against its presigned GET URL. The URL itself authenticates
 * the request (R2 ignores cookies for *.r2.cloudflarestorage.com), so
 * no `credentials: "include"` and no CSRF header.
 *
 * Why Range (not the whole body):
 *   A 200 MB log would block the tab and balloon memory. Range stops
 *   the transfer at the cap. If R2 doesn't honor Range (it does, but
 *   we don't crash if a proxy strips it), we still slice the resulting
 *   ArrayBuffer to the cap before decoding so the UI never sees more
 *   than the promised window.
 *
 * The decoder uses `fatal: false` so an incomplete multibyte sequence
 * at the byte cap renders as U+FFFD instead of throwing — the user
 * sees one funky character at the very end of the preview, which is
 * the right trade-off vs. blanking the whole view.
 */
export async function fetchTextHead(
  url: string,
  options?: { signal?: AbortSignal },
): Promise<TextPreviewResult> {
  // Range is inclusive on both ends → `0-(cap-1)` yields exactly `cap` bytes.
  const rangeEnd = PREVIEW_TEXT_BYTE_CAP - 1;
  const response = await fetch(url, {
    method: "GET",
    headers: { Range: `bytes=0-${rangeEnd}` },
    signal: options?.signal,
  });
  if (!response.ok && response.status !== 206) {
    // 200 = R2 ignored Range and sent the whole body; 206 = partial.
    // Anything else is a real failure — surface the status + text so the
    // UI's catch can render something actionable.
    const body = await safeReadText(response);
    throw new Error(
      `preview.fetch_failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const raw = await response.arrayBuffer();
  // Truncate defensively even if R2 sent more bytes than we asked for.
  // After this, the decode produces at most PREVIEW_TEXT_BYTE_CAP bytes.
  const capped =
    raw.byteLength > PREVIEW_TEXT_BYTE_CAP
      ? raw.slice(0, PREVIEW_TEXT_BYTE_CAP)
      : raw;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(capped);

  // Discover totalBytes from headers — Content-Range when R2 honored
  // Range (most common), Content-Length on a plain 200.
  let totalBytes: number | null = null;
  if (response.status === 206) {
    totalBytes = parseContentRangeTotal(response.headers.get("content-range"));
  } else {
    const cl = response.headers.get("content-length");
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n >= 0) totalBytes = n;
    }
  }

  // "Truncated" means the user is seeing less than the object holds.
  // Three signals, any one of which marks truncation:
  //   * server honored Range with a 206 AND the slash-total exceeds the
  //     cap;
  //   * server sent a 200 but the body alone was larger than the cap
  //     (we sliced it locally);
  //   * totalBytes is unknown but the raw body filled the cap exactly —
  //     more bytes may exist. Conservative side: assume truncated.
  let truncated = false;
  if (totalBytes !== null) {
    truncated = totalBytes > PREVIEW_TEXT_BYTE_CAP;
  } else if (raw.byteLength >= PREVIEW_TEXT_BYTE_CAP) {
    truncated = true;
  }

  return { text, truncated, totalBytes };
}

/** Defensive — Response.text() can throw on a body the runtime already
 *  drained. The error message is informational only, not user-facing. */
async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * useMutation wrapper around `requestPreviewPresignedUrl`. Same shape
 * as `useDownloadObject` — the UI observes `isPending`/`error` and
 * branches on `ApiClientError.code` when surfacing a toast.
 *
 * The dialog calls `mutate({...})` once when it opens; closing the
 * dialog unmounts the component so the mutation state goes away.
 * Re-opening fires a fresh presign.
 */
export function usePresignPreviewUrl(): UseMutationResult<
  R2PresignResponse,
  ApiClientError | Error,
  PreviewPresignInput
> {
  return useMutation({
    mutationFn: requestPreviewPresignedUrl,
  });
}
