// hooks/use-audit.ts
//
// TanStack Query hook for the audit-log resource:
//   - useAudit(filters) → GET /api/audit (infinite query)
//
// Same conventions as use-shares / use-connections:
//   * Query key is a typed tuple that *includes the filters* so changing
//     a filter creates a fresh cache entry rather than mutating the
//     previous one in place — pagination resets naturally.
//   * Wire helpers are plain async functions so unit tests can pin the
//     URL/method/payload without a React tree.
//   * No mutations live here — the audit table is append-only from the
//     server side; the UI is read-only.

import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type { AuditOpValue } from "@/lib/api/schemas";
import type { AuditListResponse } from "@/lib/api/types";

/** Client-side filter shape for the audit listing. Both fields optional —
 *  omitted/empty values do not narrow the result. */
export interface AuditFilters {
  op?: AuditOpValue;
  bucket?: string;
}

/** Stable query-key root for the audit listing. The filter object is
 *  appended verbatim so two different filter combos cache separately. */
export const AUDIT_QUERY_KEY = ["audit"] as const;

/** Compose the full query key for a given filter combo. Exported so tests
 *  and ad-hoc invalidations can re-derive the exact tuple. */
export function auditQueryKey(filters: AuditFilters) {
  // Normalize so trivially-different filter objects ({ bucket: "" } vs
  // {}) share a key. Empty bucket strings are treated as "unset" — the
  // input field uses "" as its uncontrolled value.
  const normalized: { op?: string; bucket?: string } = {};
  if (filters.op) normalized.op = filters.op;
  if (filters.bucket && filters.bucket.length > 0)
    normalized.bucket = filters.bucket;
  return [...AUDIT_QUERY_KEY, normalized] as const;
}

// ─── fetcher ─────────────────────────────────────────────────────────────

/** GET /api/audit?cursor=…&op=…&bucket=… — one page of audit rows. */
export function fetchAuditPage(
  filters: AuditFilters,
  cursor?: string | null,
): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  if (cursor != null && cursor.length > 0) params.set("cursor", cursor);
  if (filters.op) params.set("op", filters.op);
  if (filters.bucket && filters.bucket.length > 0)
    params.set("bucket", filters.bucket);

  const qs = params.toString();
  const url = qs.length > 0 ? `/api/audit?${qs}` : `/api/audit`;
  return apiFetch<AuditListResponse>(url);
}

// ─── hook ────────────────────────────────────────────────────────────────

/**
 * GET /api/audit — infinite list of audit rows for the current user with
 * optional op/bucket filters. The caller reads
 * `data.pages.flatMap((p) => p.items)`.
 */
export function useAudit(
  filters: AuditFilters = {},
): UseInfiniteQueryResult<
  InfiniteData<AuditListResponse>,
  ApiClientError | Error
> {
  return useInfiniteQuery({
    queryKey: auditQueryKey(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchAuditPage(filters, pageParam),
    getNextPageParam: (last) => last.nextCursor,
  });
}
