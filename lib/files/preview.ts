// lib/files/preview.ts
//
// Pure helpers for deciding HOW (and IF) an R2 object can be previewed
// inline in the browser. The choice is driven entirely by the key's
// extension — we do NOT trust a server-supplied Content-Type because
// the presigned-GET pipeline never round-trips one back, and even if it
// did, R2 reflects whatever the upload set. Extension-based detection
// is good enough for V1 (PRD §6) and stays consistent with the icon
// rendered next to each row in object-table.tsx.
//
// What this module deliberately does NOT do:
//   * No syntax highlighting hooks — that's a V2 affordance and would
//     drag a tokenizer into the bundle for a feature most users won't
//     hit. The text view is plain <pre>.
//   * No "stream the whole file" path — text preview is capped at the
//     1 MB Range fetch (see PREVIEW_TEXT_BYTE_CAP). A 50 MB log opens
//     as "first 1 MB of 50 MB" so the dialog doesn't OOM the tab.
//   * No mime sniffing — a .json file with binary inside renders as
//     garbage UTF-8 and the user gets to see that, which is the right
//     signal that something is wrong with the upload.

/**
 * Lowercase extensions whose presigned-GET URL we feel safe handing
 * directly to <img src=...>. SVG is included even though the browser
 * runs its DOM — the URL is same-origin to *.r2.cloudflarestorage.com
 * (not our app origin), so SVG <script> cannot reach app cookies.
 */
export const PREVIEW_IMAGE_EXTENSIONS = new Set<string>([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
]);

/**
 * Lowercase extensions we'll fetch with Range + decode as UTF-8.
 * Keep this list narrow — every entry is a promise that decoding the
 * first 1 MB as UTF-8 yields readable text. Add JSONL / NDJSON when a
 * user actually asks for it.
 */
export const PREVIEW_TEXT_EXTENSIONS = new Set<string>([
  "txt",
  "json",
  "md",
  "log",
  "csv",
  "xml",
  "yaml",
  "yml",
  "tsv",
  "ini",
  "conf",
]);

/** First-MB cap for text previews — the Range header sends
 *  `bytes=0-PREVIEW_TEXT_BYTE_CAP-1`. Pinned as a literal (1 MiB) so
 *  the schema, the hook, and the UI banner all read from one number. */
export const PREVIEW_TEXT_BYTE_CAP = 1_048_576;

/** Threshold above which the image view shows a loading skeleton until
 *  <img onLoad> fires. Below this, the network is fast enough that a
 *  skeleton just flashes. 10 MiB matches the PRD wording. */
export const PREVIEW_IMAGE_LARGE_BYTES = 10_485_760;

/** TTL for the preview presigned URL — 5 minutes. Short on purpose:
 *  the URL is a bearer token for the object, and a closed dialog has
 *  no use for a 15-minute URL. */
export const PREVIEW_PRESIGN_TTL_SECONDS = 300;

export type PreviewKind = "image" | "text" | "unavailable";

/**
 * Lowercase extension of an R2 key. Returns "" when none.
 *
 *   "logs/2026/server.LOG" → "log"
 *   "noext"                → ""
 *   "trailing."            → ""
 *
 * Mirrors `fileExtension` in object-table.tsx — kept independent here
 * because that one is colocated with the table view and we don't want
 * a circular dep when the dialog imports this module.
 */
export function previewExtension(key: string): string {
  // Slice off folder prefix so a "." inside a directory name doesn't
  // get mistaken for the file's extension.
  const lastSlash = key.lastIndexOf("/");
  const name = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Decide whether a key is previewable, and as what. Stable string
 * literals (`'image' | 'text' | 'unavailable'`) so callers can switch
 * over the result and the TS exhaustiveness check stays useful.
 */
export function detectPreviewKind(key: string): PreviewKind {
  const ext = previewExtension(key);
  if (!ext) return "unavailable";
  if (PREVIEW_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PREVIEW_TEXT_EXTENSIONS.has(ext)) return "text";
  return "unavailable";
}
