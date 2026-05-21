// hooks/use-objects.ts
//
// TanStack Query infinite-query hook for `GET /api/r2/list`.
//
// Why useInfiniteQuery and not useQuery + manual pagination state:
//   * R2 paginates with an opaque `nextCursor` (ContinuationToken). Each
//     /list response carries the cursor for the NEXT request, so the natural
//     fit is TanStack's `getNextPageParam(lastPage)` → drive `fetchNextPage`.
//   * The cache stores all loaded pages, so a user clicking "Load more" then
//     navigating into a child prefix and back gets the previously-loaded
//     pages back from cache instantly. Switching prefix produces a new
//     queryKey, which is what we want — the previous prefix's pages aren't
//     useful at the new one.
//
// Conventions (mirror use-buckets.ts / use-connections.ts):
//   * Query key is `["objects", cid, bucket, prefix]`. Including cid in the
//     key means switching connection doesn't clobber another connection's
//     cache for the same bucket name.
//   * `fetchObjects` is a plain function pulled out for unit tests (vitest
//     node env can call it directly without a React tree).
//   * 1-minute staleTime — objects change far more often than buckets, but
//     within the time it takes a user to switch tabs and come back we don't
//     want to refetch on every focus event. The `refetch` returned by the
//     hook lets the UI surface a manual refresh if needed.
//
// What this file deliberately does NOT do:
//   * No toast / error UI — consumers (the bucket browser page + ObjectTable)
//     branch on `isError` / `error.code` themselves.
//   * No optimistic mutation cache patching — there are no mutations here;
//     the upload / delete hooks will reach for `invalidateQueries` against
//     `objectsQueryKey(...)` to refresh this one.

import {
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type { R2ListResponse } from "@/lib/api/types";

/** One minute. Co-located with the hook so the route, docs, and the hook
 *  itself can't drift. Exported so tests can assert the chosen window. */
export const OBJECTS_STALE_TIME_MS = 60 * 1000;

/** Stable query key tuple for one (connection, bucket, prefix) triple. Use
 *  this helper anywhere you want to read or invalidate the listing cache —
 *  e.g. after an upload or delete inside the same prefix, call
 *  `queryClient.invalidateQueries({ queryKey: objectsQueryKey(cid, bucket, prefix) })`. */
export function objectsQueryKey(
  cid: string | null | undefined,
  bucket: string | null | undefined,
  prefix: string | null | undefined,
) {
  // `?? null` keeps each slot canonical when the upstream component spells
  // "no value" as either null or undefined — matches the pattern in
  // bucketsQueryKey().
  return ["objects", cid ?? null, bucket ?? null, prefix ?? ""] as const;
}

export type ObjectsQueryKey = ReturnType<typeof objectsQueryKey>;

export interface FetchObjectsParams {
  cid: string;
  bucket: string;
  prefix: string;
  /** Opaque ContinuationToken from a previous response, or undefined for
   *  the first page. */
  cursor?: string;
}

/** Build the `/api/r2/list?...` URL and call apiFetch. Split out from the
 *  hook so tests can pin the request shape without setting up React. */
export function fetchObjects(
  params: FetchObjectsParams,
): Promise<R2ListResponse> {
  // URLSearchParams handles encoding for keys that contain '/' or spaces.
  // `prefix` is always passed (even when empty) — the route schema defaults
  // missing values to "" but being explicit eliminates one source of cache
  // key drift between hook and route.
  const qs = new URLSearchParams({
    cid: params.cid,
    bucket: params.bucket,
    prefix: params.prefix,
  });
  if (params.cursor) {
    qs.set("cursor", params.cursor);
  }
  return apiFetch<R2ListResponse>(`/api/r2/list?${qs.toString()}`);
}

export interface UseObjectsArgs {
  /** ULID of the active connection, or null while none is selected. */
  cid: string | null | undefined;
  /** R2 bucket name. */
  bucket: string | null | undefined;
  /** R2-style prefix — "" or ends with "/". The hook does NOT normalize. */
  prefix: string;
}

/**
 * Folder-style listing of one R2 prefix. Pages until the user calls
 * `fetchNextPage` or the server returns `nextCursor: null`.
 *
 * Disabled (idle, no fetch) until BOTH cid and bucket are present. The
 * caller can render any "select a connection / bucket" empty state without
 * worrying about an inflight 400.
 */
export function useObjects({
  cid,
  bucket,
  prefix,
}: UseObjectsArgs): UseInfiniteQueryResult<
  InfiniteData<R2ListResponse, string | undefined>,
  ApiClientError | Error
> {
  const ready =
    typeof cid === "string" &&
    cid.length > 0 &&
    typeof bucket === "string" &&
    bucket.length > 0;

  return useInfiniteQuery({
    queryKey: objectsQueryKey(cid, bucket, prefix),
    // Only invoked when `enabled` is true; safe to non-null-assert the
    // narrowed strings.
    queryFn: ({ pageParam }) =>
      fetchObjects({
        cid: cid as string,
        bucket: bucket as string,
        prefix,
        cursor: pageParam,
      }),
    enabled: ready,
    // v5 requires an explicit initialPageParam. `undefined` means "first
    // page, no cursor" — fetchObjects skips the cursor query param in that
    // case.
    initialPageParam: undefined as string | undefined,
    // `null` from the server is the "no more pages" sentinel; coerce it to
    // `undefined` so TanStack stops the page chain. Returning `null` here
    // would actually mark the next page as available with a literal-null
    // cursor — easy to get wrong.
    getNextPageParam: (lastPage: R2ListResponse) =>
      lastPage.nextCursor ?? undefined,
    staleTime: OBJECTS_STALE_TIME_MS,
  });
}
