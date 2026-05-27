// tests/unit/uploads/dropzone-utils.test.ts
//
// Pure-function tests for lib/uploads/dropzone-utils.ts. No DOM, no
// React, no Zustand — these helpers are deliberately framework-free so
// the Vitest node environment can exercise them directly.

import { describe, it, expect } from "vitest";

import {
  MAX_UPLOAD_BYTES,
  describeQueued,
  describeSkipped,
  keyForFile,
  validateAndPartitionFiles,
} from "@/lib/uploads/dropzone-utils";

function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: "application/octet-stream",
    lastModified: 0,
    webkitRelativePath: "",
    slice: () => new Blob(),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    stream: () => undefined as never,
    text: () => Promise.resolve(""),
  } as unknown as File;
}

describe("lib/uploads/dropzone-utils", () => {
  describe("validateAndPartitionFiles", () => {
    it("accepts files at or under the 5 GiB cap", () => {
      const small = fakeFile("a.txt", 1);
      const exactlyMax = fakeFile("b.bin", MAX_UPLOAD_BYTES);
      const { accepted, skipped } = validateAndPartitionFiles([
        small,
        exactlyMax,
      ]);
      expect(accepted).toEqual([small, exactlyMax]);
      expect(skipped).toEqual([]);
    });

    it("rejects files larger than 5 GiB with reason='too-large'", () => {
      const huge = fakeFile("huge.bin", MAX_UPLOAD_BYTES + 1);
      const ok = fakeFile("ok.txt", 100);
      const { accepted, skipped } = validateAndPartitionFiles([huge, ok]);
      expect(accepted).toEqual([ok]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.file).toBe(huge);
      expect(skipped[0]!.reason).toBe("too-large");
    });

    it("rejects 0-byte files with reason='empty'", () => {
      const empty = fakeFile("dir-pretending-to-be-file", 0);
      const { accepted, skipped } = validateAndPartitionFiles([empty]);
      expect(accepted).toEqual([]);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.reason).toBe("empty");
    });

    it("preserves input order across mixed accept/skip batches", () => {
      const a = fakeFile("a", 1);
      const b = fakeFile("b", 0);
      const c = fakeFile("c", 2);
      const d = fakeFile("d", MAX_UPLOAD_BYTES + 1);
      const e = fakeFile("e", 3);
      const { accepted, skipped } = validateAndPartitionFiles([a, b, c, d, e]);
      expect(accepted.map((f) => f.name)).toEqual(["a", "c", "e"]);
      expect(skipped.map((s) => s.file.name)).toEqual(["b", "d"]);
    });

    it("returns empty buckets for an empty input list", () => {
      const result = validateAndPartitionFiles([]);
      expect(result.accepted).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });

  describe("describeSkipped", () => {
    it("returns null when nothing was skipped", () => {
      expect(describeSkipped([])).toBeNull();
    });

    it("names a single oversized file", () => {
      const desc = describeSkipped([
        {
          file: fakeFile("big.bin", MAX_UPLOAD_BYTES + 1),
          reason: "too-large",
        },
      ]);
      expect(desc).toContain("big.bin");
      expect(desc).toContain("5 GB");
    });

    it("counts multiple oversized files", () => {
      const desc = describeSkipped([
        { file: fakeFile("a", MAX_UPLOAD_BYTES + 1), reason: "too-large" },
        { file: fakeFile("b", MAX_UPLOAD_BYTES + 2), reason: "too-large" },
      ]);
      expect(desc).toContain("2 个文件");
    });

    it("combines too-large and empty reasons with a separator", () => {
      const desc = describeSkipped([
        { file: fakeFile("big", MAX_UPLOAD_BYTES + 1), reason: "too-large" },
        { file: fakeFile("zero", 0), reason: "empty" },
      ]);
      expect(desc).toContain("5 GB");
      expect(desc).toContain("为空");
      // Sanity: both fragments present implies the combiner worked.
      expect(desc?.split(" · ").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("describeQueued", () => {
    it("returns null for an empty accepted list", () => {
      expect(describeQueued([])).toBeNull();
    });

    it("names a single file", () => {
      const desc = describeQueued([fakeFile("hello.txt", 1)]);
      expect(desc).toContain("hello.txt");
    });

    it("counts multiple files", () => {
      const desc = describeQueued([
        fakeFile("a", 1),
        fakeFile("b", 2),
        fakeFile("c", 3),
      ]);
      expect(desc).toBe("已加入队列 3 个文件");
    });
  });

  describe("keyForFile", () => {
    it("places a file at the root when prefix is empty", () => {
      expect(keyForFile("", fakeFile("photo.jpg", 1))).toBe("photo.jpg");
    });

    it("concatenates a trailing-slash prefix with the file name", () => {
      expect(keyForFile("a/b/", fakeFile("photo.jpg", 1))).toBe(
        "a/b/photo.jpg",
      );
    });

    it("does not encode spaces or punctuation — the SDK signs the raw key", () => {
      expect(keyForFile("docs/", fakeFile("my file (1).pdf", 1))).toBe(
        "docs/my file (1).pdf",
      );
    });
  });
});
