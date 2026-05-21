// hooks/use-buckets.ts
//
// TanStack Query hook for listing buckets under one R2 connection.
//
// Conventions (mirrors use-connections.ts):
//   * Query key is the tuple `["buckets", cid]`. The cid is part of the
//     key so switching connection produces a separate cache entry rather
//     than clobbering the previous one — a user toggling between two
//     connections in the switcher gets instant data on the second toggle.
//   * 5 minute `staleTime` per the task brief (CLAUDE.md memory: TanStack
//     Query, one hook per resource). Bucket lists rarely change minute-to-
//     minute, and every refresh is a real R2 round-trip + a credential
//     decrypt on the server — caching keeps both bills down.
//   * The query is disabled when `cid` is null/undefined. A nullable cid is
//     the dashboard's "no connection selected yet" state; firing a fetch
//     for `cid=undefined` would just produce a guaranteed 400. We surface
//     `{ isPending: false, data: undefined }` instead, which the UI reads
//     as "show the empty switcher".
//
// What this file deliberately does NOT do:
//   * No toast / error UI — the consumer (BucketSwitcher) branches on
//     `error.code` itself.
//   * No imperative refresh helper; consumers either use the returned
//     `refetch` from useQuery or `queryClient.invalidateQueries` against
//     `bucketsQueryKey(cid)`.

import {
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type { BucketSummary } from "@/lib/api/types";

/** Build the canonical query-key tuple for a given connection id. Use this
 *  (not an ad-hoc literal) anywhere you want to read or invalidate the
 *  bucket list cache — e.g. after a connection is deleted you can
 *  `queryClient.removeQueries({ queryKey: bucketsQueryKey(deletedCid) })`. */
export function bucketsQueryKey(cid: string | null | undefined) {
  // `cid ?? null` keeps the key shape stable when `enabled` is false —
  // TanStack Query still serializes the key for type-safety, and a literal
  // `null` segment is preferable to drifting between `undefined` and `null`.
  return ["buckets", cid ?? null] as const;
}

export type BucketsQueryKey = ReturnType<typeof bucketsQueryKey>;

/** Fetch buckets for one connection from the API. Pulled out as a plain
 *  function so unit tests can pin the endpoint shape without a React tree. */
export function fetchBuckets(cid: string): Promise<BucketSummary[]> {
  // URLSearchParams over string concatenation: cid is a ULID (no chars that
  // need escaping today) but routing this through URLSearchParams future-
  // proofs against parameter typing changes — and matches what the route
  // expects (`Object.fromEntries(searchParams.entries())`).
  const qs = new URLSearchParams({ cid });
  return apiFetch<BucketSummary[]>(`/api/r2/buckets?${qs.toString()}`);
}

/**
 * Five minute cache window. Co-located so the route, the docs, and the
 * hook can't drift. Exported for tests that want to assert the config.
 */
export const BUCKETS_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * GET /api/r2/buckets?cid=<cid> — list buckets for the active connection.
 *
 * Pass `null` (or `undefined`) when no connection is selected: the query
 * stays idle and the consumer gets `{ data: undefined, isPending: false }`.
 *
 * Consumers should branch on `error.code` (via the typed `ApiClientError`)
 * when reacting to failures — `connection.invalid_credentials` and
 * `auth.unauthorized` are the two interesting cases for the BucketSwitcher.
 */
export function useBuckets(
  cid: string | null | undefined,
): UseQueryResult<BucketSummary[], ApiClientError | Error> {
  return useQuery({
    queryKey: bucketsQueryKey(cid),
    // queryFn is only invoked when `enabled` is true, but TypeScript still
    // wants a function — assert non-null after the enabled guard.
    queryFn: () => fetchBuckets(cid as string),
    enabled: typeof cid === "string" && cid.length > 0,
    staleTime: BUCKETS_STALE_TIME_MS,
  });
}
