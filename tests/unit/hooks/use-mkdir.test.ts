// tests/unit/hooks/use-mkdir.test.ts
//
// Spec for useMkdirMutation — the browser-side wrapper around
// POST /api/r2/mkdir. We mock apiFetch so the suite focuses on:
//
//   * wire shape: URL `/api/r2/mkdir`, method POST, `json:` payload exactly
//     `{ cid, bucket, parentPrefix, name }`.
//   * cache invalidation: on success, invalidate the objects listing for
//     the PARENT prefix (the one the new folder lives under). Do NOT
//     invalidate the new child prefix — nothing was cached there yet.
//   * failure: server errors bubble up as mutation errors AND do not
//     trigger invalidation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { useMkdirMutation } from "@/hooks/use-mkdir";
import { apiFetch } from "@/lib/api/client";
import { objectsQueryKey } from "@/hooks/use-objects";

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const CID = "01H6Z0K5XJX3J6X9F6X8MZBKVQ";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMkdirMutation", () => {
  it("posts to /api/r2/mkdir with json body and invalidates the parent prefix listing on success", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "logs/2025/",
      alreadyExisted: false,
    });
    const { result } = renderHook(() => useMkdirMutation(), {
      wrapper: wrapper(qc),
    });

    const vars = { cid: CID, bucket: "b", parentPrefix: "logs/", name: "2025" };
    await act(async () => {
      await result.current.mutateAsync(vars);
    });

    expect(apiFetch).toHaveBeenCalledWith("/api/r2/mkdir", {
      method: "POST",
      json: vars,
    });
    expect(spy).toHaveBeenCalledWith({
      queryKey: objectsQueryKey(CID, "b", "logs/"),
    });
  });

  it("alreadyExisted=true resolves normally (no throw); invalidation still scoped to parent prefix", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "logs/",
      alreadyExisted: true,
    });
    const { result } = renderHook(() => useMkdirMutation(), {
      wrapper: wrapper(qc),
    });

    let out: { key: string; alreadyExisted: boolean } | undefined;
    await act(async () => {
      out = await result.current.mutateAsync({
        cid: CID,
        bucket: "b",
        parentPrefix: "",
        name: "logs",
      });
    });
    expect(out).toEqual({ key: "logs/", alreadyExisted: true });
    expect(spy).toHaveBeenCalledWith({
      queryKey: objectsQueryKey(CID, "b", ""),
    });
  });

  it("server failure surfaces as mutation error and skips invalidation", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = vi.spyOn(qc, "invalidateQueries");
    (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useMkdirMutation(), {
      wrapper: wrapper(qc),
    });

    await expect(
      act(async () =>
        result.current.mutateAsync({
          cid: CID,
          bucket: "b",
          parentPrefix: "",
          name: "logs",
        }),
      ),
    ).rejects.toThrow("boom");

    expect(spy).not.toHaveBeenCalled();
  });
});
