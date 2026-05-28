// tests/unit/components/dropzone-stages.test.tsx
//
// Spec for Task 15: Dropzone routes drag/drop and click-browse through
// the staging modal instead of enqueuing uploads directly. We assert:
//   * Staging store flips to isOpen=true after a file-input change.
//   * QueuedFiles are seeded with the correct count + targetPrefix.
//   * enqueueMany on the upload queue is NOT called.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import { Dropzone } from "@/components/features/upload/dropzone";
import { useUploadStagingStore } from "@/stores/upload-staging";
import { useUploadQueueStore } from "@/stores/upload-queue";

beforeEach(() => {
  useUploadStagingStore.getState().reset();
});

describe("Dropzone (Task 15) — routes through staging modal", () => {
  it("on browse-input change: opens staging modal with the picked files; does NOT enqueue", () => {
    const enqueueManySpy = vi.spyOn(
      useUploadQueueStore.getState(),
      "enqueueMany",
    );
    const { container } = render(
      <Dropzone cid="c1" bucket="b" prefix="logs/">
        <div data-testid="child" />
      </Dropzone>,
    );

    // Pick the plain file input (not the folder input). The folder input
    // carries the `webkitdirectory` attribute; the file input does not.
    const fileInput = container.querySelector(
      'input[type="file"]:not([webkitdirectory])',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const file = new File([new Uint8Array(10)], "a.txt");
    Object.defineProperty(fileInput, "files", { value: [file] });
    fireEvent.change(fileInput);

    expect(useUploadStagingStore.getState().isOpen).toBe(true);
    expect(useUploadStagingStore.getState().files).toHaveLength(1);
    expect(useUploadStagingStore.getState().targetPrefix).toBe("logs/");
    expect(enqueueManySpy).not.toHaveBeenCalled();
  });
});
