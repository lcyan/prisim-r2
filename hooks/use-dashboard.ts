// hooks/use-dashboard.ts
//
// TanStack Query hook for GET /api/dashboard/summary.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiFetch, type ApiClientError } from "@/lib/api/client";
import type { DashboardSummary } from "@/lib/api/types";

export type DashboardRange = "7d" | "30d";

/**
 * Query key tuple for the dashboard summary. The connectionId narrows the
 * cache so switching connections doesn't show stale numbers; the range
 * narrows so toggling 7d/30d doesn't trigger an unnecessary refetch when
 * the user toggles back within staleTime.
 */
export function dashboardQueryKey(
  connectionId: string | null,
  range: DashboardRange,
) {
  return ["dashboard", "summary", connectionId, range] as const;
}

/**
 * 30s window matches the rest of the app's read cadence (audit list,
 * buckets list) — short enough that the dashboard feels live as the user
 * uploads/deletes, long enough that the navigating-around case doesn't
 * re-fire the 6-query D1 fan-out.
 */
export const DASHBOARD_STALE_TIME_MS = 30 * 1000;

export function useDashboardSummary(
  connectionId: string | null,
  range: DashboardRange,
): UseQueryResult<DashboardSummary, ApiClientError | Error> {
  return useQuery({
    queryKey: dashboardQueryKey(connectionId, range),
    queryFn: () => {
      const qs = new URLSearchParams({
        connectionId: connectionId as string,
        range,
      });
      return apiFetch<DashboardSummary>(`/api/dashboard/summary?${qs}`);
    },
    enabled: typeof connectionId === "string" && connectionId.length > 0,
    staleTime: DASHBOARD_STALE_TIME_MS,
  });
}
