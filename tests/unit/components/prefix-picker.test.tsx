// tests/unit/components/prefix-picker.test.tsx
//
// Spec for PrefixPicker. We mock @/lib/api/client.apiFetch so the
// infinite-query inside useObjects resolves with deterministic data and
// asserts cover the four entry points: folder click, manual input,
// invalid manual input, ghost new-folder, invalid ghost name.

import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn().mockResolvedValue({
    objects: [],
    prefixes: ["logs/", "data/"],
    nextCursor: null,
  }),
  ApiClientError: class extends Error {},
}));

import { PrefixPicker } from "@/components/features/upload/prefix-picker";

function withQuery(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("PrefixPicker", () => {
  it("shows folders at the initial prefix and lets the user click into one", async () => {
    const onSelect = vi.fn();
    render(
      <PrefixPicker
        cid="c1"
        bucket="b"
        initialPrefix=""
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
      { wrapper: withQuery(freshClient()) },
    );

    // After the listing resolves, "logs/" appears in the folder list.
    await screen.findByText("📁 logs/");

    fireEvent.click(screen.getByText("📁 logs/"));
    // Clicking a folder drills in but does NOT call onSelect — the user
    // must click "选择此处" to commit.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("manual input + Enter selects that prefix", () => {
    const onSelect = vi.fn();
    render(
      <PrefixPicker
        cid="c1"
        bucket="b"
        initialPrefix=""
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
      { wrapper: withQuery(freshClient()) },
    );
    const input = screen.getByPlaceholderText(/手动输入/);
    fireEvent.change(input, { target: { value: "logs/2025/q1/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("logs/2025/q1/");
  });

  it("manual input rejects invalid prefix (starts with /)", () => {
    const onSelect = vi.fn();
    render(
      <PrefixPicker
        cid="c1"
        bucket="b"
        initialPrefix=""
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
      { wrapper: withQuery(freshClient()) },
    );
    const input = screen.getByPlaceholderText(/手动输入/);
    fireEvent.change(input, { target: { value: "/logs/" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/不能以.*开头/)).toBeInTheDocument();
  });

  it("new folder inline input adds a ghost entry locally without an API call", async () => {
    const apiFetchMock = (await import("@/lib/api/client")).apiFetch as ReturnType<
      typeof vi.fn
    >;
    apiFetchMock.mockClear();
    render(
      <PrefixPicker
        cid="c1"
        bucket="b"
        initialPrefix=""
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: withQuery(freshClient()) },
    );
    fireEvent.click(screen.getByText(/新建文件夹/));
    const newInput = await screen.findByPlaceholderText(/输入文件夹名/);
    fireEvent.change(newInput, { target: { value: "new-area" } });
    fireEvent.keyDown(newInput, { key: "Enter" });

    // Ghost prefix appears in the list at the current level.
    expect(screen.getByText("📁 new-area/")).toBeInTheDocument();
    // No POST /api/r2/mkdir invocation — only /api/r2/list calls (if any).
    for (const call of apiFetchMock.mock.calls) {
      expect(call[0]).not.toContain("/api/r2/mkdir");
    }
  });

  it("invalid ghost name shows error and is rejected", async () => {
    render(
      <PrefixPicker
        cid="c1"
        bucket="b"
        initialPrefix=""
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
      { wrapper: withQuery(freshClient()) },
    );
    fireEvent.click(screen.getByText(/新建文件夹/));
    const newInput = await screen.findByPlaceholderText(/输入文件夹名/);
    fireEvent.change(newInput, { target: { value: ".." } });
    fireEvent.keyDown(newInput, { key: "Enter" });
    // The invalid name was rejected, so no ghost row appeared.
    expect(screen.queryByText(/📁 \.\.\//)).not.toBeInTheDocument();
  });

  it("\"选择此处\" footer button commits the current prefix via onSelect", async () => {
    const onSelect = vi.fn();
    render(
      <PrefixPicker
        cid="c1"
        bucket="b"
        initialPrefix=""
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
      { wrapper: withQuery(freshClient()) },
    );
    await screen.findByText("📁 logs/");
    fireEvent.click(screen.getByText("📁 logs/"));
    fireEvent.click(screen.getByText("选择此处"));
    expect(onSelect).toHaveBeenCalledWith("logs/");
  });
});
