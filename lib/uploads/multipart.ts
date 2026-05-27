// lib/uploads/multipart.ts
//
// Browser-side multipart upload helper. Coordinates the three control-plane
// calls (create/complete/abort under /api/r2/multipart/*) and the N data-plane
// PUT-per-part calls into a single async function for the dispatcher.
//
// Concurrency model (PRD: "3 parts in flight per file"):
//   * Worker pool of size PART_CONCURRENCY (default 3). Each worker plucks
//     the next pending partNumber off a shared cursor — atomic in single-
//     threaded JS, no Mutex required.
//   * On any part error OR external abort, an internal AbortController
//     fans out to every in-flight part's XHR so we don't keep eating
//     bandwidth on a doomed upload.
//   * After settle, we ALWAYS try to call /api/r2/multipart/abort on failure
//     to free the partial parts on R2 — best-effort: a failure of the abort
//     call is not surfaced (it would mask the original error and the user
//     can't do anything about it anyway).
//
// Why a separate file from single-put.ts:
//   * Multipart has materially different state (uploadId, per-part ETag map)
//     and a worker pool that single-PUT doesn't need.
//   * The single-PUT helper exports the low-level XHR primitive
//     (uploadBodyViaXhr) and the ETag-strip regex — we import those here
//     instead of duplicating to keep one authoritative implementation.
//
// What this module deliberately does NOT do:
//   * No part-level retry. Per PRD the dispatcher decides retry policy (and
//     V1 only retries at the whole-file level — multipart resume is
//     explicitly out of scope).
//   * No persistence of uploadId across reloads — closing the tab calls
//     window unload, which can't await the abort endpoint, so we accept the
//     orphaned parts and rely on R2's lifecycle rule for cleanup (CLAUDE.md
//     bucket setup note).

import { apiFetch, ApiClientError } from "@/lib/api/client";
import { R2_PRESIGN_DEFAULT_TTL_SECONDS } from "@/lib/api/schemas";
import type {
  R2MultipartCreateResponse,
  R2MultipartCompleteResponse,
  R2PresignResponse,
} from "@/lib/api/types";

import {
  UploadError,
  uploadBodyViaXhr,
  type UploadSinglePutResult,
} from "./single-put";

/* ─── constants ──────────────────────────────────────────────── */

/** Part size in bytes. 10 MB matches the PRD; S3/R2 require parts to be
 *  ≥ 5 MB except the last one. 10 MB gives reasonable per-part progress
 *  granularity without producing 10 000 parts for a 100 GB upload (which
 *  would also exceed the per-upload part limit). */
export const PART_SIZE_BYTES = 10 * 1024 * 1024;

/** Above this size we switch from single-PUT to multipart. Picked to avoid
 *  the multipart overhead (one create + N presigns + one complete) for files
 *  small enough that a single PUT is faster anyway. */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Number of part PUTs allowed in flight per file. PRD §"3×3 并发". */
export const PART_CONCURRENCY = 3;

/** S3 multipart upper bound — we trust the schema layer already capped
 *  parts arrays at 10000, but exporting the constant here makes the math
 *  explicit when the dispatcher rejects an over-sized file (would need
 *  > 10 GB at 10 MB parts). */
export const MAX_PART_COUNT = 10_000;

/* ─── public API ─────────────────────────────────────────────── */

export interface UploadMultipartInput {
  cid: string;
  bucket: string;
  key: string;
  file: File;
}

export interface UploadMultipartOptions {
  /** External cancellation. The helper bridges this to every in-flight XHR
   *  and, on abort, fires the /api/r2/multipart/abort endpoint best-effort. */
  signal: AbortSignal;
  /** Fired once after the create call succeeds so the dispatcher can stash
   *  the uploadId in the store BEFORE the parts start flowing — needed so
   *  a user cancel that arrives before any part finishes can still issue
   *  the abort endpoint call (which requires uploadId). */
  onUploadIdReady: (uploadId: string) => void;
  /** Fired on each xhr.upload.onprogress tick. The dispatcher sums these
   *  across in-flight parts plus already-done parts to compute the total
   *  bytesUploaded for the drawer's progress bar. */
  onPartProgress: (partNumber: number, bytesUploaded: number) => void;
  /** Optional: fired when a part transitions to 'uploading'. The store
   *  marks the part 'uploading' so the eventual debug UI can see the
   *  in-flight set; the drawer doesn't need this. */
  onPartStart?: (partNumber: number) => void;
  /** Optional: fired when a part finishes with its (quote-stripped) ETag.
   *  Useful for the store to drive a per-part progress display in the
   *  future; the complete call ultimately uses the etags we collect
   *  locally in this function anyway. */
  onPartDone?: (partNumber: number, etag: string) => void;
}

export interface UploadMultipartResult {
  uploadId: string;
  /** Object-level ETag returned by the complete call. NOT the MD5 — it's
   *  S3's `<hex>-<count>` form. Treat as opaque. */
  etag: string | null;
  location: string | null;
}

/**
 * Drive a multipart upload from create → parts → complete.
 *
 * Resolves on full success. Rejects with an UploadError; the kind mirrors
 * single-put.ts so the dispatcher's branching is uniform across both paths.
 */
export async function uploadMultipart(
  input: UploadMultipartInput,
  options: UploadMultipartOptions,
): Promise<UploadMultipartResult> {
  const { signal, onUploadIdReady, onPartProgress, onPartStart, onPartDone } =
    options;

  if (signal.aborted) {
    throw new UploadError("aborted", "Upload aborted before start");
  }

  // 1. create
  let createRes: R2MultipartCreateResponse;
  try {
    createRes = await apiFetch<R2MultipartCreateResponse>(
      "/api/r2/multipart/create",
      {
        method: "POST",
        json: {
          cid: input.cid,
          bucket: input.bucket,
          key: input.key,
          contentType: input.file.type || undefined,
        },
      },
    );
  } catch (err) {
    if (signal.aborted) {
      throw new UploadError(
        "aborted",
        "Upload aborted during create",
        undefined,
        err,
      );
    }
    if (err instanceof ApiClientError) {
      throw new UploadError("presign", err.message, err.status, err);
    }
    throw new UploadError(
      "presign",
      (err as Error).message ?? "multipart create failed",
      undefined,
      err,
    );
  }

  const { uploadId } = createRes;
  onUploadIdReady(uploadId);

  // 2. compute parts
  const totalBytes = input.file.size;
  const partCount = Math.ceil(totalBytes / PART_SIZE_BYTES);

  if (partCount > MAX_PART_COUNT) {
    // We minted an uploadId but the file is too big — abort to keep the
    // R2 side clean, then throw.
    await abortBestEffort(input, uploadId);
    throw new UploadError(
      "presign",
      `File too large: ${partCount} parts exceeds S3 multipart max ${MAX_PART_COUNT}`,
    );
  }

  // 3. linked controller — fans out external abort AND first-error to all
  //    in-flight parts. Workers pass linkedSignal to uploadBodyViaXhr.
  const linkedController = new AbortController();
  const onExternalAbort = () => linkedController.abort();
  if (signal.aborted) linkedController.abort();
  signal.addEventListener("abort", onExternalAbort, { once: true });

  // ETag bucket keyed by partNumber. The complete call needs every entry.
  const etags = new Map<number, string>();
  const cursor = { next: 1 };

  const runWorker = async (): Promise<void> => {
    // Single-threaded JS: cursor.next++ between awaits is safe — no two
    // workers can read the same value because no await sits inside this
    // expression.
    while (true) {
      const partNumber = cursor.next++;
      if (partNumber > partCount) return;
      if (linkedController.signal.aborted) return;

      onPartStart?.(partNumber);

      // Slice this part. File.slice is cheap — it returns a Blob view, no
      // copy until the XHR sender reads the bytes.
      const start = (partNumber - 1) * PART_SIZE_BYTES;
      const end = Math.min(start + PART_SIZE_BYTES, totalBytes);
      const partBlob = input.file.slice(start, end);

      // Presign for this exact part. R2 binds the signature to (partNumber,
      // uploadId) so we can't pre-mint all presigns up front.
      let presign: R2PresignResponse;
      try {
        presign = await apiFetch<R2PresignResponse>("/api/r2/presign", {
          method: "POST",
          json: {
            op: "upload-part",
            cid: input.cid,
            bucket: input.bucket,
            key: input.key,
            uploadId,
            partNumber,
            ttl: R2_PRESIGN_DEFAULT_TTL_SECONDS,
          },
        });
      } catch (err) {
        if (linkedController.signal.aborted) {
          throw new UploadError(
            "aborted",
            `Part ${partNumber} aborted during presign`,
            undefined,
            err,
          );
        }
        if (err instanceof ApiClientError) {
          throw new UploadError("presign", err.message, err.status, err);
        }
        throw new UploadError(
          "presign",
          (err as Error).message ?? "part presign failed",
          undefined,
          err,
        );
      }

      const result: UploadSinglePutResult = await uploadBodyViaXhr({
        url: presign.url,
        body: partBlob,
        // R2 ignores Content-Type on UploadPart — the part is a slice of an
        // opaque object — but the XHR layer requires a string. Use
        // octet-stream to be explicit rather than relying on the browser's
        // default (which Safari sets to `text/plain` for unknown blobs and
        // surfaces a confusing signature mismatch if the presign route ever
        // grows a Content-Type sign-with header).
        contentType: "application/octet-stream",
        signal: linkedController.signal,
        onProgress: (bytes) => onPartProgress(partNumber, bytes),
      });

      etags.set(partNumber, result.etag);
      onPartDone?.(partNumber, result.etag);
    }
  };

  // 4. spawn worker pool
  const workers = Array.from(
    { length: Math.min(PART_CONCURRENCY, partCount) },
    () => runWorker(),
  );

  let firstError: unknown = null;
  const settled = await Promise.allSettled(workers);
  for (const s of settled) {
    if (s.status === "rejected" && firstError === null) {
      firstError = s.reason;
      // Cancel any laggard workers — though if Promise.allSettled returned,
      // they have all settled. Defensive in case we ever switch to Promise.all.
      linkedController.abort();
    }
  }

  // Always detach the external listener before any return path — leaving it
  // attached would keep the closure alive for the lifetime of the caller's
  // AbortController.
  signal.removeEventListener("abort", onExternalAbort);

  if (firstError !== null) {
    // Best-effort abort on R2 to release the parts we already uploaded.
    await abortBestEffort(input, uploadId);
    // If the external signal was the cause, normalize to 'aborted' even if
    // an individual part rejected as 'http' due to the abort racing the
    // last byte send.
    if (
      signal.aborted &&
      !(firstError instanceof UploadError && firstError.kind === "presign")
    ) {
      throw new UploadError(
        "aborted",
        "Multipart upload aborted",
        undefined,
        firstError,
      );
    }
    if (firstError instanceof UploadError) throw firstError;
    throw new UploadError(
      "network",
      (firstError as Error).message ?? "part upload failed",
      undefined,
      firstError,
    );
  }

  // 5. complete — parts must be sorted by partNumber, but the route layer
  //    also defends in depth (lib/r2/control.ts sorts before sending to S3).
  const parts = [...etags.entries()]
    .map(([partNumber, etag]) => ({ partNumber, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);

  let completeRes: R2MultipartCompleteResponse;
  try {
    completeRes = await apiFetch<R2MultipartCompleteResponse>(
      "/api/r2/multipart/complete",
      {
        method: "POST",
        json: {
          cid: input.cid,
          bucket: input.bucket,
          key: input.key,
          uploadId,
          parts,
        },
      },
    );
  } catch (err) {
    // Complete failed — try to abort so we don't leave orphan parts.
    await abortBestEffort(input, uploadId);
    if (err instanceof ApiClientError) {
      throw new UploadError("http", err.message, err.status, err);
    }
    throw new UploadError(
      "network",
      (err as Error).message ?? "complete failed",
      undefined,
      err,
    );
  }

  return {
    uploadId,
    etag: completeRes.etag,
    location: completeRes.location,
  };
}

/* ─── helpers ────────────────────────────────────────────────── */

/**
 * Fire and (best-effort) await the multipart abort endpoint. Swallows every
 * error: the dispatcher already has the original failure to surface, and a
 * failed abort means R2 will reclaim the parts via the bucket's lifecycle
 * rule (operator setup, not a code fix).
 */
async function abortBestEffort(
  input: Pick<UploadMultipartInput, "cid" | "bucket" | "key">,
  uploadId: string,
): Promise<void> {
  try {
    await apiFetch<void>("/api/r2/multipart/abort", {
      method: "POST",
      json: {
        cid: input.cid,
        bucket: input.bucket,
        key: input.key,
        uploadId,
      },
    });
  } catch {
    // Intentionally silent — see function comment.
  }
}
