// tests/unit/hooks/use-objects-items.test.ts
//
// Spec for two derived selectors added to use-objects.ts:
//
//   * useObjectsItems — flattens paged R2ListResponse into ObjectsItemRow[]
//     and filters out the 0-byte placeholder whose key equals the current
//     prefix (folder-marker convention from putEmptyObject).
//   * useLoadAllObjects — controlled loop that calls fetchNextPage until
//     hasNextPage is false, the cap is reached, or stop() is called.

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { useObjectsItems, useLoadAllObjects } from "@/hooks/use-objects";
import type { R2ListResponse } from "@/lib/api/types";

type Q = UseInfiniteQueryResult<
  InfiniteData<R2ListResponse, string | undefined>,
  Error
>;

function makeQueryResult(args: {
  pages: R2ListResponse[];
  hasNextPage: boolean;
  fetchNextPage?: () => Promise<unknown>;
}): Q {
  return {
    data: {
      pages: args.pages,
      pageParams: args.pages.map(() => undefined as string | undefined),
    },
    hasNextPage: args.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: args.fetchNextPage ?? vi.fn(),
  } as unknown as Q;
}

describe("useObjectsItems", () => {
  it("flattens prefixes + objects across pages and reports total + hasNext", () => {
    const q = makeQueryResult({
      pages: [
        {
          prefixes: ["a/"],
          objects: [{ key: "x.txt", size: 10, etag: null, lastModified: 0 }],
          nextCursor: "tok",
        },
        {
          prefixes: ["b/"],
          objects: [{ key: "y.txt", size: 20, etag: null, lastModified: 0 }],
          nextCursor: null,
        },
      ],
      hasNextPage: false,
    });
    const { result } = renderHook(() => useObjectsItems(q, "logs/"));
    expect(result.current.total).toBe(4);
    expect(result.current.hasNext).toBe(false);
    expect(result.current.items[0]).toMatchObject({
      kind: "prefix",
      key: "a/",
    });
  });

  it("filters out the 0-byte placeholder whose key equals currentPrefix", () => {
    const q = makeQueryResult({
      pages: [
        {
          prefixes: [],
          objects: [
            { key: "logs/", size: 0, etag: null, lastModified: 0 },
            { key: "x.txt", size: 10, etag: null, lastModified: 0 },
          ],
          nextCursor: null,
        },
      ],
      hasNextPage: false,
    });
    const { result } = renderHook(() => useObjectsItems(q, "logs/"));
    expect(
      result.current.items.find((i) => i.key === "logs/"),
    ).toBeUndefined();
    expect(result.current.total).toBe(1);
  });

  it("at root prefix '' the filter is a no-op (no key equals empty string)", () => {
    const q = makeQueryResult({
      pages: [
        {
          prefixes: [],
          objects: [{ key: "x.txt", size: 10, etag: null, lastModified: 0 }],
          nextCursor: null,
        },
      ],
      hasNextPage: false,
    });
    const { result } = renderHook(() => useObjectsItems(q, ""));
    expect(result.current.total).toBe(1);
  });
});

describe("useLoadAllObjects", () => {
  it("calls fetchNextPage until hasNextPage flips false", async () => {
    let calls = 0;
    const q = makeQueryResult({
      pages: [{ prefixes: [], objects: [], nextCursor: "1" }],
      hasNextPage: true,
    });
    Object.defineProperty(q, "hasNextPage", { get: () => calls < 3 });
    (q.fetchNextPage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        calls += 1;
      },
    );

    const { result } = renderHook(() => useLoadAllObjects(q));
    await act(async () => {
      await result.current.loadAll();
    });
    expect(calls).toBe(3);
  });

  it("respects the page cap (5 pages) and sets cappedOnLastRun", async () => {
    let calls = 0;
    const q = makeQueryResult({
      pages: [{ prefixes: [], objects: [], nextCursor: "1" }],
      hasNextPage: true,
    });
    Object.defineProperty(q, "hasNextPage", { get: () => true });
    (q.fetchNextPage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        calls += 1;
      },
    );

    const { result } = renderHook(() => useLoadAllObjects(q));
    await act(async () => {
      await result.current.loadAll();
    });
    expect(calls).toBe(5);
    expect(result.current.cappedOnLastRun).toBe(true);
  });

  it("aborts when stop() is called mid-run", async () => {
    let calls = 0;
    let resultRef: { current: { stop: () => void } } | null = null;
    const q = makeQueryResult({
      pages: [{ prefixes: [], objects: [], nextCursor: "1" }],
      hasNextPage: true,
    });
    Object.defineProperty(q, "hasNextPage", { get: () => true });
    (q.fetchNextPage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        calls += 1;
        if (calls === 2 && resultRef) resultRef.current.stop();
      },
    );
    const rendered = renderHook(() => useLoadAllObjects(q));
    resultRef = rendered.result as unknown as {
      current: { stop: () => void };
    };
    await act(async () => {
      await rendered.result.current.loadAll();
    });
    expect(calls).toBeLessThanOrEqual(3);
  });
});
