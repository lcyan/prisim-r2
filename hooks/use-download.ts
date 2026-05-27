// hooks/use-download.ts
//
// Single-file download via presigned GET. Mints a short-lived signed URL
// against POST /api/r2/presign and hands the browser the URL through a
// transient `<a download>` so the native download manager handles the
// rest — progress UI, large files, pause/resume on supported browsers.
//
// Why a mutation, not a query:
//   The download is a side effect, not a cacheable value. Each click should
//   mint a fresh URL (TTLs are 15 min and presigned URLs are bearer tokens
//   for the object — re-using a cached one would extend the leak window and
//   would also miss a freshly-rotated R2 key). TanStack Query's `useMutation`
//   matches the "trigger, observe pending/error, never auto-refetch" shape.
//
// Conventions (mirror use-buckets.ts / use-objects.ts):
//   * Wire helpers (`requestPresignedDownloadUrl`, `triggerNativeDownload`,
//     `deriveDownloadFilename`) are plain exported functions so vitest can
//     pin the URL/method/DOM behavior without a React tree.
//   * No toast / error UI here — `error` is surfaced through the mutation
//     state and the component layer maps `ApiClientError.code` to a toast.
//   * No retries: re-trying a failed presign would write a second audit row
//     and double-bill the rate limit; the user can click again.
//
// What this file deliberately does NOT do:
//   * No `ResponseContentDisposition` plumbing — the task brief is "the
//     browser's native download manager handles it"; cross-origin URLs may
//     ignore the `download` attribute and surface inline, but that's a
//     known R2 CORS gotcha (CLAUDE.md) the user resolves at the bucket
//     level. The hook does its part by setting `download` + `rel="noopener"`.
//   * No resume / chunked retry — V1 explicitly defers that.

import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import { R2_PRESIGN_DEFAULT_TTL_SECONDS } from "@/lib/api/schemas";
import type { R2PresignResponse } from "@/lib/api/types";

/** Default URL lifetime for download presigns. Centralized as `900s` via
 *  `R2_PRESIGN_DEFAULT_TTL_SECONDS` — re-exported here so callers (tests,
 *  docs, the page wiring) can refer to ONE name when reasoning about the
 *  download TTL specifically. */
export const DOWNLOAD_PRESIGN_TTL_SECONDS = R2_PRESIGN_DEFAULT_TTL_SECONDS;

export interface DownloadObjectInput {
  /** ULID of the active connection. */
  cid: string;
  /** R2 bucket name. */
  bucket: string;
  /** Full object key (no leading "/"). */
  key: string;
  /** Override the filename hint the browser uses when saving. Defaults to
   *  the trailing segment of `key` — see `deriveDownloadFilename`. */
  filename?: string;
}

/**
 * Compute the filename a downloaded file should be saved under.
 *
 *   "logs/2026/05/server.log" → "server.log"
 *
 * Pure function with two reasons to exist:
 *   1. It's the same rule the object table uses for display names, so the
 *      saved file matches what the user clicked on.
 *   2. R2 keys legitimately can contain "/" and "." — splitting on the last
 *      segment is safer than `key.split("/").pop()` because trailing
 *      slashes (folder markers; never selectable in this UI but defensive)
 *      collapse to the empty string.
 *
 * Caller MAY override via `DownloadObjectInput.filename` if it has a
 * better human-friendly name (e.g. a renamed copy from the metadata).
 */
export function deriveDownloadFilename(key: string): string {
  // Drop any trailing slashes, then pull the last segment. Empty fallback
  // is `key` itself, so the user never gets a blank "Save as" prompt.
  const trimmed = key.replace(/\/+$/u, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed || key;
}

/** Build the request body for POST /api/r2/presign (op="get"). Extracted so
 *  tests can pin the wire shape without rendering the hook. `ttl` is fixed
 *  at the export above — the server clamps anything past 7200s anyway, but
 *  pinning the value here keeps the audit story consistent (the audit row
 *  records the bucket/key but not the TTL, so "what TTL did this download
 *  use?" needs to be answerable by reading source). */
export function requestPresignedDownloadUrl(input: {
  cid: string;
  bucket: string;
  key: string;
}): Promise<R2PresignResponse> {
  return apiFetch<R2PresignResponse>("/api/r2/presign", {
    method: "POST",
    json: {
      op: "get",
      cid: input.cid,
      bucket: input.bucket,
      key: input.key,
      ttl: DOWNLOAD_PRESIGN_TTL_SECONDS,
    },
  });
}

/**
 * Hand the browser a URL and a filename so its native download manager
 * takes over. Creating + clicking + removing a transient `<a>` is the
 * cross-browser way to start a download programmatically — `window.location
 * = url` would navigate (and inline anything the browser can render), and
 * `window.open(url)` would surface a popup blocker.
 *
 * `rel="noopener"` is defensive: presigned URLs point at *.r2.cloudflarestorage.com
 * which we do not control. Even though the click is same-tab, isolating
 * window.opener costs nothing.
 *
 * Pure function on the DOM (no React, no QueryClient) so tests stub
 * `document.createElement` / `document.body.appendChild` and assert the
 * sequence.
 */
export function triggerNativeDownload(url: string, filename: string): void {
  if (typeof document === "undefined") {
    // SSR safety. The mutation only fires in response to a user click, so
    // this branch is unreachable in practice — but throwing here would
    // turn an SSR render-pass into a 500. Better to no-op.
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // `display:none` avoids a flash of a focusable element in the tab order
  // between append and click.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Trigger a single-file download. Returns the TanStack Query mutation so
 * the caller can observe `isPending` (to disable the row's Download button)
 * and `error` (to render a toast).
 *
 * The hook itself never throws — `mutateAsync` / `mutate` surface failures
 * through the mutation state, matching the connections / upload patterns.
 *
 * Failure modes worth handling at the call site:
 *   * `auth.unauthorized`        — OUR session is gone. Bounce to /login.
 *   * `csrf.invalid`             — refresh the CSRF cookie (apiFetch will
 *                                   bootstrap one on the next mutation).
 *   * `rate_limited`             — show "too many downloads, try again in N s".
 *   * `connection.invalid_credentials` (mapped to `auth.unauthorized` by
 *     the presign route via R2CredentialError) — the user's R2 keys are
 *     stale; prompt them to re-add the connection.
 *   * any other code             — generic toast with `err.requestId` so
 *                                   support can grep audit_log.
 */
export function useDownloadObject(): UseMutationResult<
  R2PresignResponse,
  ApiClientError | Error,
  DownloadObjectInput
> {
  return useMutation({
    mutationFn: async (input: DownloadObjectInput) => {
      const result = await requestPresignedDownloadUrl({
        cid: input.cid,
        bucket: input.bucket,
        key: input.key,
      });
      const filename = input.filename ?? deriveDownloadFilename(input.key);
      // Trigger AFTER awaiting the URL so a network failure short-circuits
      // before we touch the DOM — no half-finished <a> left behind.
      triggerNativeDownload(result.url, filename);
      return result;
    },
  });
}
