// tests/unit/components/confirm-upload-card.test.tsx
//
// Spec for ConfirmUploadCard. We mock @/lib/api/client.apiFetch so the
// useObjects-driven conflict detector resolves with a deterministic empty
// listing (no conflicts). The store is the source of truth for visibility
// + file list; the test seeds it via .open({...}).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    objects: [],
    prefixes: [],
    nextCursor: null,
  }),
  ApiClientError: class extends Error {},
}));

import { ConfirmUploadCard } from "@/components/features/upload/confirm-upload-card";
import { useUploadStagingStore } from "@/stores/upload-staging";

function fakeFile(name: string, size = 100): File {
  return new File([new Uint8Array(size)], name);
}

function withQC(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

beforeEach(() => {
  useUploadStagingStore.getState().reset();
});

describe("ConfirmUploadCard", () => {
  it("renders nothing when staging is closed", () => {
    const { container } = render(
      <ConfirmUploadCard cid="c1" bucket="b" onCommit={vi.fn()} />,
      { wrapper: withQC(freshClient()) },
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders file count and target prefix; commit fires with accepted files", () => {
    useUploadStagingStore.getState().open({
      files: [
        { file: fakeFile("a.txt"), name: "a.txt", relativePath: "" },
        { file: fakeFile("b.txt"), name: "b.txt", relativePath: "" },
      ],
      targetPrefix: "logs/",
    });

    const onCommit = vi.fn();
    render(<ConfirmUploadCard cid="c1" bucket="b" onCommit={onCommit} />, {
      wrapper: withQC(freshClient()),
    });

    expect(screen.getByText(/待上传 2 个文件/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("logs/")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/开始上传/));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const args = onCommit.mock.calls[0]![0];
    expect(args.accepted.length).toBe(2);
    expect(args.targetPrefix).toBe("logs/");
  });

  it("toggling '包含隐藏文件' moves hidden files between accepted and skipped", () => {
    useUploadStagingStore.getState().open({
      files: [
        { file: fakeFile("a.txt"), name: "a.txt", relativePath: "" },
        { file: fakeFile(".DS_Store"), name: ".DS_Store", relativePath: "" },
      ],
      targetPrefix: "",
    });

    render(<ConfirmUploadCard cid="c1" bucket="b" onCommit={vi.fn()} />, {
      wrapper: withQC(freshClient()),
    });

    // Default: 1 visible, 1 hidden-skipped.
    expect(screen.getByText(/待上传 1 个文件/)).toBeInTheDocument();

    // Toggle include-hidden.
    fireEvent.click(screen.getByLabelText(/包含隐藏文件/));
    expect(screen.getByText(/待上传 2 个文件/)).toBeInTheDocument();
  });

  it("cancel closes the staging store (isOpen flips back to false)", () => {
    useUploadStagingStore.getState().open({
      files: [{ file: fakeFile("a.txt"), name: "a.txt", relativePath: "" }],
      targetPrefix: "",
    });
    render(<ConfirmUploadCard cid="c1" bucket="b" onCommit={vi.fn()} />, {
      wrapper: withQC(freshClient()),
    });
    fireEvent.click(screen.getByText(/取消/));
    expect(useUploadStagingStore.getState().isOpen).toBe(false);
  });

  it("commit closes the staging store (parent doesn't need its own reset)", () => {
    useUploadStagingStore.getState().open({
      files: [{ file: fakeFile("a.txt"), name: "a.txt", relativePath: "" }],
      targetPrefix: "logs/",
    });
    render(<ConfirmUploadCard cid="c1" bucket="b" onCommit={vi.fn()} />, {
      wrapper: withQC(freshClient()),
    });
    fireEvent.click(screen.getByText(/开始上传/));
    expect(useUploadStagingStore.getState().isOpen).toBe(false);
  });
});
