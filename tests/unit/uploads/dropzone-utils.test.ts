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
  filesToQueuedFiles,
  isHiddenFile,
  keyForFile,
  keyForQueuedFile,
  partitionQueuedFiles,
  QueuedFileSkipReason,
  validateAndPartitionFiles,
  type QueuedFile,
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

/* ─── Task 2: QueuedFile / partition / readers ─────────────────── */

function realFakeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, {
    type: "application/octet-stream",
  });
}
function fakeFileWithRel(rel: string, size: number): File {
  const base = rel.split("/").pop() ?? rel;
  const f = realFakeFile(base, size);
  Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
}

describe("filesToQueuedFiles", () => {
  it("flat files get empty relativePath", () => {
    const a = realFakeFile("a.txt", 5);
    const out = filesToQueuedFiles([a]);
    expect(out).toEqual([{ file: a, name: "a.txt", relativePath: "" }]);
  });

  it("webkitRelativePath is folded into relativePath, keeping the source folder name", () => {
    const f = fakeFileWithRel("report/2025/q1.pdf", 9);
    const out = filesToQueuedFiles([f]);
    expect(out[0]?.relativePath).toBe("report/2025/");
    expect(out[0]?.name).toBe("q1.pdf");
  });
});

describe("keyForQueuedFile", () => {
  it.each([
    ["", "", "a.txt", "a.txt"],
    ["logs/", "", "a.txt", "logs/a.txt"],
    ["logs/", "2025/", "a.txt", "logs/2025/a.txt"],
    ["", "report/2025/", "q1.pdf", "report/2025/q1.pdf"],
  ])(
    "target=%j rel=%j name=%j → %j",
    (prefix, rel, name, expected) => {
      const qf: QueuedFile = {
        file: realFakeFile(name, 1),
        name,
        relativePath: rel,
      };
      expect(keyForQueuedFile(prefix, qf)).toBe(expected);
    },
  );
});

describe("isHiddenFile", () => {
  it.each([".DS_Store", ".env", "._foo", "Thumbs.db"])(
    "treats %s as hidden",
    (name) => expect(isHiddenFile(name)).toBe(true),
  );
  it.each(["foo.txt", "report.pdf", "x.docx"])(
    "treats %s as visible",
    (name) => expect(isHiddenFile(name)).toBe(false),
  );
});

describe("partitionQueuedFiles", () => {
  const baseArgs = { targetPrefix: "logs/", includeHidden: false };

  it("accepts normal files", () => {
    const qf: QueuedFile = {
      file: realFakeFile("a.txt", 10),
      name: "a.txt",
      relativePath: "",
    };
    const result = partitionQueuedFiles({ ...baseArgs, files: [qf] });
    expect(result.accepted).toEqual([qf]);
    expect(result.skipped).toEqual([]);
  });

  it("rejects empty files", () => {
    const qf: QueuedFile = {
      file: realFakeFile("a.txt", 0),
      name: "a.txt",
      relativePath: "",
    };
    expect(
      partitionQueuedFiles({ ...baseArgs, files: [qf] }).skipped[0]?.reason,
    ).toBe(QueuedFileSkipReason.Empty);
  });

  it("rejects parent-traversal segments", () => {
    const qf: QueuedFile = {
      file: realFakeFile("a.txt", 5),
      name: "a.txt",
      relativePath: "../sibling/",
    };
    expect(
      partitionQueuedFiles({ ...baseArgs, files: [qf] }).skipped[0]?.reason,
    ).toBe(QueuedFileSkipReason.ParentTraversal);
  });

  it("rejects hidden when includeHidden=false", () => {
    const qf: QueuedFile = {
      file: realFakeFile(".DS_Store", 5),
      name: ".DS_Store",
      relativePath: "",
    };
    expect(
      partitionQueuedFiles({ ...baseArgs, files: [qf] }).skipped[0]?.reason,
    ).toBe(QueuedFileSkipReason.Hidden);
  });

  it("allows hidden when includeHidden=true", () => {
    const qf: QueuedFile = {
      file: realFakeFile(".env", 5),
      name: ".env",
      relativePath: "",
    };
    const result = partitionQueuedFiles({
      ...baseArgs,
      includeHidden: true,
      files: [qf],
    });
    expect(result.accepted).toHaveLength(1);
  });

  it("rejects when final key would exceed 1024 utf-8 bytes", () => {
    // logs/ (5) + seg/ (513+1) + seg/ (513+1) + a.txt (5) = 1038 bytes > 1024
    const longSeg = "x".repeat(513);
    const qf: QueuedFile = {
      file: realFakeFile("a.txt", 5),
      name: "a.txt",
      relativePath: `${longSeg}/${longSeg}/`,
    };
    expect(
      partitionQueuedFiles({ ...baseArgs, files: [qf] }).skipped[0]?.reason,
    ).toBe(QueuedFileSkipReason.KeyTooLong);
  });
});
