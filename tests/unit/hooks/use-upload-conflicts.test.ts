// tests/unit/hooks/use-upload-conflicts.test.ts
//
// Spec for useUploadConflicts — a cache-only diff that feeds the
// confirm-upload modal. We don't hit the network, so the test seeds the
// TanStack Query cache directly with `objectsQueryKey(...)` shaped data
// and asserts the hook surfaces the right conflict set + depth-warning
// flag.

import { describe, it, expect } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import React from "react";

import { useUploadConflicts } from "@/hooks/use-upload-conflicts";
import { objectsQueryKey } from "@/hooks/use-objects";

function withClient(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function seedCache(
  qc: QueryClient,
  args: {
    cid: string;
    bucket: string;
    prefix: string;
    keys: string[];
    hasNext?: boolean;
  },
) {
  qc.setQueryData(objectsQueryKey(args.cid, args.bucket, args.prefix), {
    pages: [
      {
        prefixes: [],
        objects: args.keys.map((k) => ({
          key: k,
          size: 1,
          etag: null,
          lastModified: 0,
        })),
        nextCursor: args.hasNext ? "tok" : null,
      },
    ],
    pageParams: [undefined],
  });
}

describe("useUploadConflicts", () => {
  it("flags hasUncheckedDepth=true when the target prefix has no cache (we couldn't have checked anything)", () => {
    const qc = new QueryClient();
    const { result } = renderHook(
      () =>
        useUploadConflicts({
          cid: "c1",
          bucket: "b",
          targetPrefix: "logs/",
          queuedKeys: ["logs/a.txt"],
        }),
      { wrapper: withClient(qc) },
    );
    expect(result.current.conflictKeys.size).toBe(0);
    expect(result.current.hasUncheckedDepth).toBe(true);
  });

  it("detects conflicts present in cache", () => {
    const qc = new QueryClient();
    seedCache(qc, {
      cid: "c1",
      bucket: "b",
      prefix: "logs/",
      keys: ["logs/a.txt", "logs/b.txt"],
    });
    const { result } = renderHook(
      () =>
        useUploadConflicts({
          cid: "c1",
          bucket: "b",
          targetPrefix: "logs/",
          queuedKeys: ["logs/a.txt", "logs/c.txt"],
        }),
      { wrapper: withClient(qc) },
    );
    expect(result.current.conflictKeys.has("logs/a.txt")).toBe(true);
    expect(result.current.conflictKeys.has("logs/c.txt")).toBe(false);
    expect(result.current.hasUncheckedDepth).toBe(false);
  });

  it("flags hasUncheckedDepth=true when the cache reports nextCursor (more pages exist server-side)", () => {
    const qc = new QueryClient();
    seedCache(qc, {
      cid: "c1",
      bucket: "b",
      prefix: "logs/",
      keys: ["logs/a.txt"],
      hasNext: true,
    });
    const { result } = renderHook(
      () =>
        useUploadConflicts({
          cid: "c1",
          bucket: "b",
          targetPrefix: "logs/",
          queuedKeys: ["logs/a.txt"],
        }),
      { wrapper: withClient(qc) },
    );
    expect(result.current.hasUncheckedDepth).toBe(true);
    // Conflict still surfaces — depth-warning is additive.
    expect(result.current.conflictKeys.has("logs/a.txt")).toBe(true);
  });

  it("returns empty set when cid or bucket is null (hook idles until both are present)", () => {
    const qc = new QueryClient();
    const { result } = renderHook(
      () =>
        useUploadConflicts({
          cid: null,
          bucket: "b",
          targetPrefix: "logs/",
          queuedKeys: ["logs/a.txt"],
        }),
      { wrapper: withClient(qc) },
    );
    expect(result.current.conflictKeys.size).toBe(0);
    expect(result.current.hasUncheckedDepth).toBe(false);
  });
});
