// lib/uploads/dropzone-utils.ts
//
// DOM-free helpers used by the Dropzone UI. Pulled out into their own
// module so the Vitest suite (which runs under the node environment, no
// jsdom) can unit-test them without faking drag events.
//
// Why a separate module from `dropzone.tsx`:
//   * The component depends on React, sonner, and the Zustand store; tests
//     for "is this 6 GB file too big?" should not boot any of that.
//   * The single-file size cap mirrors R2's documented PUT limit (5 GiB);
//     keeping it in a shared module means the dropzone, the page, and any
//     future drag-handler we wire up cannot drift.

/** 5 GiB — R2 single-PUT cap. The multipart workflow could go higher
 *  (up to 4.995 TiB), but enforcing the PUT limit here keeps the V1
 *  upload UX from accepting a 50 GB file that we'd have to abort 95 GB
 *  of the way in due to PART_CONCURRENCY / part-count limits. Document
 *  in user-facing copy so the rejection isn't a mystery. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export type SkipReason = "too-large" | "empty";

export interface SkippedFile {
  file: File;
  reason: SkipReason;
}

export interface PartitionResult {
  accepted: File[];
  skipped: SkippedFile[];
}

/** Validates a batch of files against the upload constraints and splits
 *  them into accepted vs skipped buckets. Pure — no DOM, no React, no
 *  store side-effects. The Dropzone component owns the side-effects
 *  (enqueueMany + toast) so this function stays trivially testable.
 *
 *  Current rules:
 *    * size <= MAX_UPLOAD_BYTES (5 GiB)
 *    * size > 0 — a 0-byte drop is almost always the browser handing us
 *      a directory or a placeholder rather than a real empty file. R2
 *      accepts 0-byte objects but the multipart helper doesn't, and the
 *      single-PUT path's UploadError messaging for an empty body is
 *      confusing. Cleaner to reject up front.
 */
export function validateAndPartitionFiles(
  files: readonly File[],
): PartitionResult {
  const accepted: File[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    if (file.size === 0) {
      skipped.push({ file, reason: "empty" });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      skipped.push({ file, reason: "too-large" });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, skipped };
}

/** Toast description text for a skipped batch. Returned as `string | null`
 *  so the caller can suppress the toast entirely when nothing was skipped
 *  without sprinkling `if (skipped.length)` at the callsite. */
export function describeSkipped(
  skipped: ReadonlyArray<SkippedFile>,
): string | null {
  if (skipped.length === 0) return null;
  const tooLarge = skipped.filter((s) => s.reason === "too-large");
  const empty = skipped.filter((s) => s.reason === "empty");
  const parts: string[] = [];
  if (tooLarge.length > 0) {
    parts.push(
      tooLarge.length === 1
        ? `“${tooLarge[0]!.file.name}” 超过 5 GB`
        : `${tooLarge.length} 个文件超过 5 GB`,
    );
  }
  if (empty.length > 0) {
    parts.push(
      empty.length === 1
        ? `“${empty[0]!.file.name}” 为空`
        : `${empty.length} 个文件为空`,
    );
  }
  return parts.join(" · ");
}

/** Toast title for the success branch. Returns null when nothing was
 *  queued so the Dropzone never raises an empty success toast. */
export function describeQueued(accepted: ReadonlyArray<File>): string | null {
  if (accepted.length === 0) return null;
  if (accepted.length === 1) {
    return `已加入队列：“${accepted[0]!.name}”`;
  }
  return `已加入队列 ${accepted.length} 个文件`;
}

/** Build the destination R2 key for a file dropped into a given prefix.
 *  Prefix is expected to be "" (root) or end with "/" — see
 *  `lib/r2/prefix.ts` for the invariant. The File's `name` may contain
 *  spaces or punctuation; we deliberately do NOT encode it here because
 *  the presign route signs the raw key and the SDK is responsible for
 *  url-encoding it on the wire. */
export function keyForFile(prefix: string, file: File): string {
  return `${prefix}${file.name}`;
}
