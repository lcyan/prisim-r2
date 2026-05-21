// lib/uploads/single-put.ts
//
// Browser-side helper that performs a single PUT upload against R2 using a
// presigned URL. Returns the object's ETag so the dispatcher can hand it to
// the audit / drawer layer.
//
// Why XMLHttpRequest and not fetch():
//   * fetch() doesn't expose upload progress events. The drawer's per-file
//     progress bar and speed chip both require byte-level upload telemetry.
//   * The streams-based "upload via ReadableStream + count bytes" workaround
//     requires the HTTP/2 + duplex stream proposal, which Safari still does
//     not ship. Sticking with XHR keeps coverage at "every browser we
//     support".
//   * We pay the price of inventing UploadError instead of getting fetch()'s
//     unified rejection model, but the dispatcher needs the kind discriminator
//     anyway to label tasks as canceled vs failed (the user-visible difference
//     is destructive: one shows a retry chip, the other doesn't).
//
// Cancellation:
//   * Forwarded via AbortSignal — the helper attaches a 'abort' listener
//     that calls xhr.abort(). The signal is also checked before the presign
//     call so a fast cancel (drag, release, instantly click X) never burns
//     a presign rate-limit budget on a doomed upload.
//
// What this module deliberately does NOT do:
//   * No retry. The dispatcher decides retry policy. A single attempt keeps
//     this helper testable without faking a stable failure clock.
//   * No content-MD5 / SHA-256 sidecar headers. R2's presigned URL signature
//     does not bind the body hash; if we wanted integrity verification we'd
//     have to opt into S3's `x-amz-content-sha256` and the presign route
//     would need to mirror that. Out of scope for V1.

import { apiFetch, ApiClientError } from "@/lib/api/client";
import { R2_PRESIGN_DEFAULT_TTL_SECONDS } from "@/lib/api/schemas";
import type { R2PresignResponse } from "@/lib/api/types";

/* ─── error type shared with the multipart helper ────────────── */

/** Categories the dispatcher branches on:
 *  - 'aborted' — user cancel (do NOT show as failed)
 *  - 'presign' — control-plane call failed (auth, csrf, rate-limit)
 *  - 'network' — XHR onerror / ontimeout (transport-level)
 *  - 'http'    — XHR completed with non-2xx (R2 returned a body error) */
export type UploadErrorKind = "aborted" | "presign" | "network" | "http";

/** Thrown by the upload helpers. The dispatcher inspects `kind` to decide
 *  whether to mark the task 'canceled' or 'failed', and uses `message` for
 *  the row's tooltip. `status` is set for kind='http' only. */
export class UploadError extends Error {
  constructor(
    public readonly kind: UploadErrorKind,
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/* ─── public API ─────────────────────────────────────────────── */

export interface UploadSinglePutInput {
  cid: string;
  bucket: string;
  key: string;
  file: File;
}

export interface UploadSinglePutOptions {
  /** Forwarded into XHR.abort() when fired. The helper throws UploadError
   *  kind='aborted' on abort — even if the abort lands *between* presign
   *  and XHR open, in which case no XHR is created at all. */
  signal: AbortSignal;
  /** Fired on each xhr.upload.onprogress tick with the running byte total.
   *  The dispatcher throttles its store writes — this callback should be
   *  cheap (no React state) so the throttle layer can decide cadence. */
  onProgress: (bytesUploaded: number) => void;
}

export interface UploadSinglePutResult {
  /** R2 ETag for the uploaded object. Quotes stripped — pass straight into
   *  any downstream call without escaping. */
  etag: string;
}

/**
 * Upload a file via a single presigned PUT.
 *
 * Flow:
 *   1. Throw immediately if the signal was already aborted (caller pattern:
 *      `if (signal.aborted) skip work`).
 *   2. Call POST /api/r2/presign op='put' to mint a short-lived URL.
 *   3. PUT the file body via XHR, forwarding upload progress.
 *   4. On 2xx return the ETag (quotes stripped); on non-2xx / network /
 *      abort throw a typed UploadError.
 */
export async function uploadSinglePut(
  input: UploadSinglePutInput,
  options: UploadSinglePutOptions,
): Promise<UploadSinglePutResult> {
  const { signal, onProgress } = options;

  // Early-out for an already-aborted signal. Without this, the dispatcher
  // could burn a presign rate-limit slot for a task the user just X'd.
  if (signal.aborted) {
    throw new UploadError("aborted", "Upload aborted before start");
  }

  let presign: R2PresignResponse;
  try {
    presign = await apiFetch<R2PresignResponse>("/api/r2/presign", {
      method: "POST",
      json: {
        op: "put",
        cid: input.cid,
        bucket: input.bucket,
        key: input.key,
        ttl: R2_PRESIGN_DEFAULT_TTL_SECONDS,
      },
    });
  } catch (err) {
    // The signal may have flipped while we were awaiting the presign; if so,
    // surface as 'aborted' rather than 'presign' so the dispatcher labels
    // the task canceled-not-failed.
    if (signal.aborted) {
      throw new UploadError("aborted", "Upload aborted during presign", undefined, err);
    }
    if (err instanceof ApiClientError) {
      throw new UploadError("presign", err.message, err.status, err);
    }
    throw new UploadError("presign", (err as Error).message ?? "presign failed", undefined, err);
  }

  // Second guard — abort that landed exactly between presign return and
  // XHR open. Once XHR is open the signal listener handles abort directly.
  if (signal.aborted) {
    throw new UploadError("aborted", "Upload aborted after presign");
  }

  return uploadBodyViaXhr({
    url: presign.url,
    body: input.file,
    contentType: input.file.type || "application/octet-stream",
    signal,
    onProgress,
  });
}

/* ─── internals (also reused by the multipart helper) ────────── */

interface XhrUploadParams {
  url: string;
  /** File or Blob — both have a `.size` and stream straight into XHR. */
  body: Blob;
  contentType: string;
  signal: AbortSignal;
  onProgress: (bytesUploaded: number) => void;
}

/**
 * Low-level XHR PUT used by both the single-put and multipart helpers.
 * Resolves with the ETag (quotes stripped) on 2xx, rejects with an
 * UploadError on every failure path.
 *
 * Exported because the multipart helper needs the same control flow for
 * each part — and writing it twice would invite drift in the ETag-strip
 * regex (R2 may also return etags with surrounding `W/"..."` for weak
 * variants, though we have not observed that on PutObject responses).
 */
export function uploadBodyViaXhr(
  params: XhrUploadParams,
): Promise<UploadSinglePutResult> {
  const { url, body, contentType, signal, onProgress } = params;

  return new Promise<UploadSinglePutResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Listener references stored so we can detach after settlement. Leaking
    // the signal listener would pin XHR + body in memory for the lifetime
    // of the dispatcher's AbortController — usually short, but worth being
    // tidy about for very long-running multi-file uploads.
    const onAbort = () => {
      // xhr.abort() fires xhr.onabort; the rejection path lives there to
      // unify "user-aborted before send" and "user-aborted mid-flight".
      xhr.abort();
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onProgress(ev.loaded);
      }
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        const raw = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag") ?? "";
        const etag = stripEtagQuotes(raw);
        if (!etag) {
          // R2 always returns an ETag for PutObject / UploadPart; missing
          // it means the response is malformed or the bucket CORS hides it.
          // Surface as kind='http' with the status so the user sees an
          // actionable hint rather than a silent "succeeded with no etag".
          reject(
            new UploadError(
              "http",
              "Upload succeeded but server did not return an ETag — check bucket CORS exposes the ETag header",
              xhr.status,
            ),
          );
          return;
        }
        resolve({ etag });
      } else {
        // xhr.responseText may contain an S3 error body. Keep it short —
        // the drawer only has a tooltip-sized slot for the message.
        const snippet = (xhr.responseText ?? "").slice(0, 160);
        reject(
          new UploadError(
            "http",
            `Upload failed: HTTP ${xhr.status}${snippet ? ` — ${snippet}` : ""}`,
            xhr.status,
          ),
        );
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new UploadError("network", "Network error during upload"));
    };

    xhr.ontimeout = () => {
      cleanup();
      reject(new UploadError("network", "Upload timed out"));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new UploadError("aborted", "Upload aborted"));
    };

    // Wire abort BEFORE open() so a synchronous abort during this turn
    // is caught — addEventListener fires immediately if already aborted
    // only via { once: true } semantics, so we also fast-fail just in case.
    if (signal.aborted) {
      // No XHR work has started yet — short-circuit without going through
      // onAbort to keep the rejection deterministic.
      cleanup();
      reject(new UploadError("aborted", "Upload aborted before send"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(body);
  });
}

/**
 * Strip the surrounding double-quotes R2 / S3 wrap their ETag in.
 *
 *   '"abc123"' → 'abc123'
 *   'abc123'   → 'abc123'   (defensive: tolerate already-stripped)
 *   ''         → ''         (caller decides how to handle missing)
 *
 * Exported so the multipart helper's part-collector can use the same
 * regex without copy/paste drift.
 */
export function stripEtagQuotes(raw: string): string {
  return raw.replace(/^"|"$/g, "").trim();
}
