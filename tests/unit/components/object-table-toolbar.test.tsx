// tests/unit/components/object-table-toolbar.test.tsx
//
// Spec for the Task 17 toolbar additions to ObjectTable.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  resetObservers,
  lastObserver,
} from "@/tests/stubs/intersection-observer";
import { ObjectTable } from "@/components/features/files/object-table";
import type { ObjectRow } from "@/components/features/files/object-table";

const emptyRows: ObjectRow[] = [];
const oneFile: ObjectRow[] = [
  { kind: "file", key: "a.txt", size: 10, lastModified: 0 },
];

const baseProps = {
  items: emptyRows,
  isLoading: false,
  isError: false,
  errorMessage: null,
  onRetry: vi.fn(),
  onFolderClick: vi.fn(),
  onLoadMore: vi.fn(),
  selectedCount: 0,
  onClearSelection: vi.fn(),
  hasNextPage: false,
  isFetchingNextPage: false,
  total: 0,
  onMkdir: vi.fn(),
  onLoadAll: vi.fn(),
  onStopLoadAll: vi.fn(),
  isLoadingAll: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetObservers();
  globalThis.localStorage?.clear?.();
});

describe("ObjectTable toolbar (Task 17)", () => {
  it('shows "已加载 N 项 · 还有更多" when hasNextPage', () => {
    render(
      <ObjectTable
        {...baseProps}
        items={oneFile}
        total={1}
        hasNextPage={true}
      />,
    );
    expect(screen.getByText(/已加载 1 项/)).toBeInTheDocument();
    expect(screen.getByText(/还有更多/)).toBeInTheDocument();
  });

  it('shows "全部 N 项" when no next page', () => {
    render(
      <ObjectTable
        {...baseProps}
        items={oneFile}
        total={1}
        hasNextPage={false}
      />,
    );
    expect(screen.getByText(/全部 1 项/)).toBeInTheDocument();
  });

  it("auto-load toggle persists to localStorage", () => {
    render(<ObjectTable {...baseProps} />);
    const toggle = screen.getByLabelText("自动加载") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(localStorage.getItem("prisim-r2:auto-load-objects")).toBe("false");
  });

  it("sentinel fires onLoadMore when intersecting and auto-load is on and hasNextPage is true", () => {
    const onLoadMore = vi.fn();
    render(
      <ObjectTable
        {...baseProps}
        items={oneFile}
        total={1}
        hasNextPage={true}
        onLoadMore={onLoadMore}
      />,
    );
    lastObserver().trigger(true);
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("'新建文件夹' opens an inline input that submits the name on Enter", () => {
    const onMkdir = vi.fn();
    render(<ObjectTable {...baseProps} onMkdir={onMkdir} />);
    fireEvent.click(screen.getByText("新建文件夹"));
    const input = screen.getByPlaceholderText("文件夹名");
    fireEvent.change(input, { target: { value: "logs" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onMkdir).toHaveBeenCalledWith("logs");
  });

  it("'全部加载' button calls onLoadAll", () => {
    const onLoadAll = vi.fn();
    render(
      <ObjectTable
        {...baseProps}
        hasNextPage={true}
        onLoadAll={onLoadAll}
      />,
    );
    fireEvent.click(screen.getByText("全部加载"));
    expect(onLoadAll).toHaveBeenCalled();
  });
});
