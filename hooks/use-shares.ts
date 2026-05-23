// hooks/use-shares.ts
//
// TanStack Query hooks for the shares resource:
//   - useShares()         → GET  /api/share         (infinite query)
//   - useCreateShare()    → POST /api/share/create
//   - useRevealShare()    → POST /api/share/:id/reveal
//   - useDeleteShare()    → DELETE /api/share/:id
//
// Same conventions as use-connections.ts:
//   * Query keys are exported `as const` tuples so other modules can
//     invalidate without re-declaring the literal.
//   * Wire helpers are plain async functions so unit tests can pin the
//     URL/method/payload without a React tree.
//   * Mutations close the loop via invalidateQueries — listing rows reflect
//     the new server state on next render. We deliberately do NOT do an
//     optimistic patch on create: the server returns the bearer URL exactly
//     once and the cache should not retain it.
//
// What this file deliberately does NOT do:
//   * No url caching. ShareCreateResponse.url lives only in the mutation
//     result that the dialog reads inline; we never write it into the
//     listing cache.
//   * No retries on mutate — each create writes an audit row and consumes
//     a slot in the share-create rate limit, so the user clicking again
//     is the correct retry surface.

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type InfiniteData,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type {
  ShareCreateInput,
  ShareTtlSeconds,
} from "@/lib/api/schemas";
import type {
  ShareCreateResponse,
  ShareDeleteResponse,
  ShareListResponse,
  ShareRevealResponse,
} from "@/lib/api/types";

/** Stable query key for the active-shares listing. */
export const SHARES_QUERY_KEY = ["shares"] as const;
export type SharesQueryKey = typeof SHARES_QUERY_KEY;

// ─── fetchers ────────────────────────────────────────────────────────────

/** GET /api/share?cursor=… — one page of active shares. */
export function fetchSharePage(
  cursor?: string | null,
): Promise<ShareListResponse> {
  const url =
    cursor != null && cursor.length > 0
      ? `/api/share?cursor=${encodeURIComponent(cursor)}`
      : `/api/share`;
  return apiFetch<ShareListResponse>(url);
}

/** POST /api/share/create — mint a presigned URL and persist the record. */
export function createShare(
  input: ShareCreateInput,
): Promise<ShareCreateResponse> {
  return apiFetch<ShareCreateResponse>("/api/share/create", {
    method: "POST",
    json: input,
  });
}

/** DELETE /api/share/:id — drop the bookkeeping row. */
export function deleteShare(id: string): Promise<ShareDeleteResponse> {
  return apiFetch<ShareDeleteResponse>(`/api/share/${id}`, {
    method: "DELETE",
  });
}

/** POST /api/share/:id/reveal — re-mint a presigned URL for an existing
 *  share row. Returns a NEW signature with the row's REMAINING TTL so the
 *  new URL stops working at the same wall-clock time as the original. */
export function revealShare(id: string): Promise<ShareRevealResponse> {
  return apiFetch<ShareRevealResponse>(`/api/share/${id}/reveal`, {
    method: "POST",
  });
}

// ─── hooks ───────────────────────────────────────────────────────────────

/**
 * GET /api/share — infinite list of active shares for the current user.
 * Cursor pagination matches the buckets / objects pattern; the caller
 * reads `data.pages.flatMap((p) => p.items)`.
 */
export function useShares(): UseInfiniteQueryResult<
  InfiniteData<ShareListResponse>,
  ApiClientError | Error
> {
  return useInfiniteQuery({
    queryKey: SHARES_QUERY_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchSharePage(pageParam),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * POST /api/share/create — mint + persist. Caller renders the returned
 * `url` once (the only chance — list responses do NOT include it).
 *
 * Failure modes worth handling at the call site:
 *   * `validation.invalid`         — ttlSeconds outside the 3 allowed values.
 *   * `auth.unauthorized`          — OUR session is gone, OR R2 keys rejected.
 *   * `resource.not_found`         — the cid doesn't belong to this user.
 *   * `rate_limited`               — 30/min cap; show "wait N s".
 */
export function useCreateShare(): UseMutationResult<
  ShareCreateResponse,
  ApiClientError | Error,
  { cid: string; bucket: string; key: string; ttlSeconds: ShareTtlSeconds }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createShare,
    onSuccess: () => {
      // Invalidate the listing so the new row shows up on the /shares page.
      // We do NOT setQueryData with the create response: the URL is
      // intentionally excluded from the listing wire shape, so writing
      // anything into the cache here would either lie about the URL field
      // or require a manual project step that would drift over time.
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
    },
  });
}

/** DELETE /api/share/:id — drop the bookkeeping row. URL stays valid until
 *  its upstream expiry; the page warns the user accordingly. */
export function useDeleteShare(): UseMutationResult<
  ShareDeleteResponse,
  ApiClientError | Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteShare,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
    },
  });
}

/**
 * POST /api/share/:id/reveal — re-mint a presigned URL for a share row.
 *
 * The new URL has a different signature than the original but expires at
 * the exact same wall-clock time (we pass remaining TTL). Caller renders
 * the returned `url` in the reveal dialog; we do NOT cache it.
 *
 * Failure modes worth handling at the call site:
 *   * `resource.not_found` — row doesn't belong to the user OR it's
 *     already expired (intentionally indistinguishable for privacy).
 *   * `auth.unauthorized` — R2 rejected the saved creds; user must re-add.
 *   * `rate_limited`      — 60/min presign cap.
 */
export function useRevealShare(): UseMutationResult<
  ShareRevealResponse,
  ApiClientError | Error,
  string
> {
  return useMutation({
    mutationFn: revealShare,
    // Intentionally no invalidation: the listing wire shape excludes the
    // url field, so there's nothing to refresh after a reveal — the only
    // surface that consumes the URL is the mutation result itself.
  });
}
