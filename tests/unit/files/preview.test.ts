// tests/unit/files/preview.test.ts
//
// Pinning the extension-based classification + constants for the inline
// preview surface. The dialog branches on `detectPreviewKind()`'s
// string-literal return value, so any drift here would surface as a
// silent regression where (e.g.) an .svg suddenly renders as "not
// available" instead of an inline image.

import { describe, it, expect } from "vitest";

import {
  PREVIEW_IMAGE_EXTENSIONS,
  PREVIEW_IMAGE_LARGE_BYTES,
  PREVIEW_PRESIGN_TTL_SECONDS,
  PREVIEW_TEXT_BYTE_CAP,
  PREVIEW_TEXT_EXTENSIONS,
  detectPreviewKind,
  previewExtension,
} from "@/lib/files/preview";

describe("previewExtension", () => {
  it("returns the lowercased trailing extension", () => {
    expect(previewExtension("logs/server.LOG")).toBe("log");
  });

  it("ignores dots inside folder names", () => {
    // The path component "v1.0" should not contaminate the file's ext.
    expect(previewExtension("a.b/c/file.txt")).toBe("txt");
  });

  it("returns '' for keys without an extension", () => {
    expect(previewExtension("README")).toBe("");
    expect(previewExtension("path/to/Makefile")).toBe("");
  });

  it("returns '' when the only dot is the leading char (dotfile)", () => {
    // ".env" is conventionally a dotfile (no extension), and treating
    // "env" as an extension would surface env files as previewable text
    // — that's almost always a security mistake (secrets in the open).
    expect(previewExtension(".env")).toBe("");
  });

  it("returns '' for a trailing dot with nothing after", () => {
    expect(previewExtension("weird.")).toBe("");
  });
});

describe("detectPreviewKind", () => {
  it("classifies common images", () => {
    for (const ext of [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "svg",
      "avif",
    ]) {
      expect(detectPreviewKind(`pic.${ext}`)).toBe("image");
    }
  });

  it("classifies common text formats", () => {
    for (const ext of [
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
    ]) {
      expect(detectPreviewKind(`f.${ext}`)).toBe("text");
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(detectPreviewKind("photo.PNG")).toBe("image");
    expect(detectPreviewKind("README.MD")).toBe("text");
  });

  it("returns 'unavailable' for binary formats", () => {
    // Each of these should NOT preview inline — they'd render as garbled
    // UTF-8 or break the dialog's layout.
    expect(detectPreviewKind("backup.zip")).toBe("unavailable");
    expect(detectPreviewKind("doc.pdf")).toBe("unavailable");
    expect(detectPreviewKind("vid.mp4")).toBe("unavailable");
    expect(detectPreviewKind("font.woff2")).toBe("unavailable");
  });

  it("returns 'unavailable' for keys with no extension", () => {
    expect(detectPreviewKind("LICENSE")).toBe("unavailable");
    expect(detectPreviewKind("path/to/binary")).toBe("unavailable");
  });

  it("returns 'unavailable' for the leading-dotfile case (.env)", () => {
    // Direct cousin of the previewExtension test — pinned at the
    // classifier level so a future refactor can't accidentally surface
    // .env as previewable text.
    expect(detectPreviewKind(".env")).toBe("unavailable");
  });
});

describe("preview constants", () => {
  it("text cap is exactly 1 MiB", () => {
    // Pinned: changing this is a UX + memory call (the whole text body
    // stays in React state). Tests should fail visibly if someone
    // doubles it without thinking through OOM on mobile Safari.
    expect(PREVIEW_TEXT_BYTE_CAP).toBe(1_048_576);
  });

  it("large-image skeleton threshold is 10 MiB", () => {
    expect(PREVIEW_IMAGE_LARGE_BYTES).toBe(10_485_760);
  });

  it("presign TTL is 5 minutes (300s) — short on purpose", () => {
    // The dialog is short-lived; a 15-minute URL would extend the leak
    // window for no UX benefit. Pinned so future refactors can't drift.
    expect(PREVIEW_PRESIGN_TTL_SECONDS).toBe(300);
  });

  it("extension sets and detector agree on classifications", () => {
    // Belt-and-suspenders: if someone adds an extension to a set but
    // forgets the detector branch (or vice versa), this loop catches it.
    for (const ext of PREVIEW_IMAGE_EXTENSIONS) {
      expect(detectPreviewKind(`file.${ext}`)).toBe("image");
    }
    for (const ext of PREVIEW_TEXT_EXTENSIONS) {
      expect(detectPreviewKind(`file.${ext}`)).toBe("text");
    }
  });
});
