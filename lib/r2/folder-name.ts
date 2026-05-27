// lib/r2/folder-name.ts
//
// User-supplied single-segment folder name validator. Shared by:
//   * client-side mkdir form (immediate UX feedback)
//   * server-side POST /api/r2/mkdir (second-line defense against a
//     hand-rolled client bypassing schema)
//
// Pure — no I/O, no React, no D1. Tests run under vitest node env.
//
// Rules:
//   1. Trim surrounding whitespace; empty-after-trim is invalid.
//   2. Unicode NFC normalize.
//   3. Reject "." and "..".
//   4. Reject any "/" or control character (U+0000..U+001F, U+007F).
//   5. Reject UTF-8 byte length > 255.
//   6. Reject Windows reserved bare names (CON / PRN / AUX / NUL /
//      COM[1-9] / LPT[1-9]), case-insensitive, no extension.

export const FolderNameError = {
  Empty: "empty",
  DotName: "dot-name",
  ContainsSlash: "contains-slash",
  ControlChar: "control-char",
  TooLong: "too-long",
  WindowsReserved: "windows-reserved",
} as const;

export type FolderNameErrorReason =
  (typeof FolderNameError)[keyof typeof FolderNameError];

export type ValidateFolderNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: FolderNameErrorReason };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CONTROL_OR_DEL = /[\x00-\x1f\x7f]/u;
const MAX_BYTES = 255;

// Lazily-instantiated TextEncoder so module load is free under Node ESM.
let _enc: TextEncoder | null = null;
function utf8ByteLen(s: string): number {
  _enc ??= new TextEncoder();
  return _enc.encode(s).length;
}

export function validateFolderName(input: string): ValidateFolderNameResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: FolderNameError.Empty };
  }
  const normalized = trimmed.normalize("NFC");
  if (normalized === "." || normalized === "..") {
    return { ok: false, reason: FolderNameError.DotName };
  }
  if (normalized.includes("/")) {
    return { ok: false, reason: FolderNameError.ContainsSlash };
  }
  if (CONTROL_OR_DEL.test(normalized)) {
    return { ok: false, reason: FolderNameError.ControlChar };
  }
  if (utf8ByteLen(normalized) > MAX_BYTES) {
    return { ok: false, reason: FolderNameError.TooLong };
  }
  if (WINDOWS_RESERVED.test(normalized)) {
    return { ok: false, reason: FolderNameError.WindowsReserved };
  }
  return { ok: true, name: normalized };
}

/** Human-readable reason for the validator's `reason` enum. Used by both
 *  client toasts and server-side ApiError message. */
export function describeFolderNameError(reason: FolderNameErrorReason): string {
  switch (reason) {
    case FolderNameError.Empty:
      return "名称不能为空";
    case FolderNameError.DotName:
      return "不能使用 “.” 或 “..”";
    case FolderNameError.ContainsSlash:
      return "名称不能包含 “/”";
    case FolderNameError.ControlChar:
      return "名称包含控制字符";
    case FolderNameError.TooLong:
      return "名称过长(最多 255 字节)";
    case FolderNameError.WindowsReserved:
      return "不能使用系统保留名";
  }
}
