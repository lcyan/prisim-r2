// tests/unit/stores/upload-staging.test.ts
//
// Spec for the confirm-upload modal's short-lived staging store. Five
// concerns:
//
//   * Initial state: closed, empty, hidden-files off.
//   * `set()` opens the modal with files + target prefix.
//   * `setTargetPrefix` updates target prefix without closing the modal.
//   * `toggleIncludeHidden` flips the boolean.
//   * `reset()` returns to the initial state.

import { describe, it, expect, beforeEach } from "vitest";
import { useUploadStagingStore } from "@/stores/upload-staging";
import type { QueuedFile } from "@/lib/uploads/dropzone-utils";

function fakeFile(name: string): File {
  return new File([new Uint8Array(4)], name);
}

beforeEach(() => {
  useUploadStagingStore.getState().reset();
});

describe("upload-staging store", () => {
  it("starts closed and empty", () => {
    const s = useUploadStagingStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.files).toEqual([]);
    expect(s.includeHidden).toBe(false);
    expect(s.targetPrefix).toBe("");
  });

  it("set() opens the modal with files and target prefix", () => {
    const files: QueuedFile[] = [
      { file: fakeFile("a.txt"), name: "a.txt", relativePath: "" },
    ];
    useUploadStagingStore.getState().set({
      files,
      targetPrefix: "logs/",
    });
    const s = useUploadStagingStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.files).toBe(files);
    expect(s.targetPrefix).toBe("logs/");
  });

  it("setTargetPrefix updates only target prefix", () => {
    useUploadStagingStore.getState().set({
      files: [{ file: fakeFile("a.txt"), name: "a.txt", relativePath: "" }],
      targetPrefix: "logs/",
    });
    useUploadStagingStore.getState().setTargetPrefix("data/");
    expect(useUploadStagingStore.getState().targetPrefix).toBe("data/");
    expect(useUploadStagingStore.getState().isOpen).toBe(true);
  });

  it("toggleIncludeHidden flips the flag", () => {
    useUploadStagingStore.getState().toggleIncludeHidden();
    expect(useUploadStagingStore.getState().includeHidden).toBe(true);
    useUploadStagingStore.getState().toggleIncludeHidden();
    expect(useUploadStagingStore.getState().includeHidden).toBe(false);
  });

  it("reset() clears everything and closes the modal", () => {
    useUploadStagingStore.getState().set({
      files: [{ file: fakeFile("a.txt"), name: "a.txt", relativePath: "" }],
      targetPrefix: "logs/",
    });
    useUploadStagingStore.getState().toggleIncludeHidden();
    useUploadStagingStore.getState().reset();
    const s = useUploadStagingStore.getState();
    expect(s.isOpen).toBe(false);
    expect(s.files).toEqual([]);
    expect(s.includeHidden).toBe(false);
    expect(s.targetPrefix).toBe("");
  });
});
