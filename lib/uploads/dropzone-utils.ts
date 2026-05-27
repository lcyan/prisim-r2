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

/* ─── folder-aware QueuedFile model (Task 2) ─────────────────── */

/** Unified intermediate representation used by the confirm-upload modal,
 *  the conflict detector, and the dispatcher. DnD vs <input> branches die
 *  in the readers below — downstream code only sees this shape. */
export interface QueuedFile {
  file: File;
  /** Just the file name, no path. */
  name: string;
  /** POSIX relative path of the file's parent folder, relative to the
   *  source root. Empty string when the file is at the source root.
   *  Always normalized to either "" or `^.+/$/`. */
  relativePath: string;
}

/** Categorical reason a QueuedFile is dropped from the batch. */
export const QueuedFileSkipReason = {
  TooLarge: "too-large",
  Empty: "empty",
  Hidden: "hidden",
  ParentTraversal: "parent-traversal",
  KeyTooLong: "key-too-long",
} as const;
export type QueuedFileSkipReasonValue =
  (typeof QueuedFileSkipReason)[keyof typeof QueuedFileSkipReason];

export interface QueuedFileSkip {
  qf: QueuedFile;
  reason: QueuedFileSkipReasonValue;
}
export interface PartitionQueuedResult {
  accepted: QueuedFile[];
  skipped: QueuedFileSkip[];
}

/** Compute the final R2 key for a QueuedFile relative to a target prefix.
 *  Mirrors `keyForFile` but folds the file's own relativePath in. */
export function keyForQueuedFile(targetPrefix: string, qf: QueuedFile): string {
  // targetPrefix is "" or ends with "/"; relativePath is "" or ends with "/".
  return `${targetPrefix}${qf.relativePath}${qf.name}`;
}

/** Heuristic: names starting with "." or "._" treated as hidden / macOS
 *  resource forks. Also handles the well-known DS_Store / Thumbs.db. */
export function isHiddenFile(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith(".")) return true;
  if (name === "Thumbs.db") return true;
  return false;
}

/** Validate a batch of QueuedFiles against the upload constraints + the
 *  target prefix. Pure — no DOM, no React, no toast side-effects.
 *
 *  Beyond `validateAndPartitionFiles` (size-only), this also enforces:
 *    - `..` segment in `relativePath` → rejected (parent traversal)
 *    - hidden file → rejected when `includeHidden === false`
 *    - final key (`targetPrefix + relativePath + name`) > 1024 bytes → rejected
 */
export function partitionQueuedFiles(args: {
  files: readonly QueuedFile[];
  targetPrefix: string;
  includeHidden: boolean;
}): PartitionQueuedResult {
  const accepted: QueuedFile[] = [];
  const skipped: QueuedFileSkip[] = [];

  for (const qf of args.files) {
    if (qf.file.size === 0) {
      skipped.push({ qf, reason: QueuedFileSkipReason.Empty });
      continue;
    }
    if (qf.file.size > MAX_UPLOAD_BYTES) {
      skipped.push({ qf, reason: QueuedFileSkipReason.TooLarge });
      continue;
    }
    // relativePath segments check
    const segments = qf.relativePath
      .split("/")
      .filter((s) => s.length > 0);
    if (segments.some((s) => s === "..")) {
      skipped.push({ qf, reason: QueuedFileSkipReason.ParentTraversal });
      continue;
    }
    if (!args.includeHidden && isHiddenFile(qf.name)) {
      skipped.push({ qf, reason: QueuedFileSkipReason.Hidden });
      continue;
    }
    const finalKey = keyForQueuedFile(args.targetPrefix, qf);
    if (utf8ByteLen(finalKey) > 1024) {
      skipped.push({ qf, reason: QueuedFileSkipReason.KeyTooLong });
      continue;
    }
    accepted.push(qf);
  }

  return { accepted, skipped };
}

let _enc: TextEncoder | null = null;
function utf8ByteLen(s: string): number {
  _enc ??= new TextEncoder();
  return _enc.encode(s).length;
}

/* ─── readers ─────────────────────────────────────────────────── */

/** Build QueuedFiles from `<input type=file webkitdirectory>` output.
 *  Each File has `webkitRelativePath` like "report/2025/q1.pdf". The
 *  first segment is the source root name — we KEEP it in relativePath
 *  because the user dragging a folder typically expects the folder
 *  itself to appear under the target prefix (Finder/Explorer parity). */
export function filesToQueuedFiles(files: FileList | readonly File[]): QueuedFile[] {
  const out: QueuedFile[] = [];
  const arr = Array.isArray(files) ? files : Array.from(files as FileList);
  for (const file of arr) {
    const rel = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    if (rel && rel.length > 0) {
      const lastSlash = rel.lastIndexOf("/");
      const dir = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
      out.push({ file, name: file.name, relativePath: dir });
    } else {
      out.push({ file, name: file.name, relativePath: "" });
    }
  }
  return out;
}

/** Convert a DataTransferItemList from a drop event into QueuedFiles.
 *  Recursively walks any DirectoryEntry children using webkitGetAsEntry().
 *  Plain file items are added with relativePath = "". Non-file items are
 *  ignored.
 *
 *  We mirror the Finder behaviour: dragging a folder `report/` in
 *  produces files with relativePath beginning at `report/...`. */
export async function readDropAsQueuedFiles(
  items: DataTransferItemList,
): Promise<QueuedFile[]> {
  const out: QueuedFile[] = [];
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind !== "file") continue;
    // webkitGetAsEntry returns null if it's not actually a file/dir.
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntry | null;
    }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  for (const entry of entries) {
    await walkEntry(entry, "", out);
  }
  return out;
}

async function walkEntry(
  entry: FileSystemEntry,
  parentPath: string,
  out: QueuedFile[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) =>
      fileEntry.file(resolve, reject),
    );
    out.push({ file, name: file.name, relativePath: parentPath });
    return;
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const children = await readAllEntries(reader);
    const nextPath = `${parentPath}${entry.name}/`;
    for (const child of children) {
      await walkEntry(child, nextPath, out);
    }
  }
}

/** readEntries() is documented to return at most ~100 entries per call;
 *  loop until it returns an empty batch to enumerate all children. */
function readAllEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          pump();
        },
        (err) => reject(err),
      );
    };
    pump();
  });
}
