// hooks/use-connections.ts
//
// TanStack Query hooks for the connections resource. ONE hook per CRUD op
// so consumers only re-render on the data they actually depend on.
//
// Conventions:
//   * Query key is a single, stable tuple — `CONNECTIONS_QUERY_KEY = ["connections"]`.
//     Centralized so a future "select active connection" hook can reuse it
//     without duplicating the literal.
//   * All network I/O goes through `apiFetch`, which transparently handles
//     CSRF cookie/header and turns the unified error envelope into a typed
//     `ApiClientError`. Components catch + branch on `err.code`.
//   * Mutations do BOTH an optimistic cache patch and a follow-up
//     invalidation. The patch keeps the UI snappy; the invalidation closes
//     the loop if the server normalized something we didn't predict (e.g.
//     trim/lowercase a name).
//
// What this file deliberately does NOT do:
//   * No toast / error UI here — that's the component's job. Hooks just
//     surface `.error`, `.isError`, `.isPending` and the caller decides
//     how to react.
//   * No retries beyond the QueryClient default (1 for queries, 0 for
//     mutations). Re-trying a POST/DELETE silently would conflict with
//     the audit-log model (every attempt is logged).

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type {
  ConnectionsCreateInput,
  ConnectionsPatchInput,
} from "@/lib/api/schemas";
import type { ConnectionSummary } from "@/lib/api/types";

/** Stable query key tuple. Tuple-as-const so TanStack's key serialization is
 *  deterministic and consumers can reuse the same reference to invalidate. */
export const CONNECTIONS_QUERY_KEY = ["connections"] as const;
export type ConnectionsQueryKey = typeof CONNECTIONS_QUERY_KEY;

// ─── fetchers ────────────────────────────────────────────────────────────
//
// Plain async functions sitting underneath the hooks. Split out so unit
// tests can pin endpoint + method + payload without needing a React tree
// or @testing-library/react. The hooks below are thin wrappers — any
// change to the wire shape lives in one of these four functions.

/** GET /api/connections — list. */
export function fetchConnections(): Promise<ConnectionSummary[]> {
  return apiFetch<ConnectionSummary[]>("/api/connections");
}

/** POST /api/connections — create a connection (server probes R2). */
export function createConnection(
  input: ConnectionsCreateInput,
): Promise<ConnectionSummary> {
  return apiFetch<ConnectionSummary>("/api/connections", {
    method: "POST",
    json: input,
  });
}

/** PATCH /api/connections/[id] — rename only. */
export function updateConnection({
  id,
  ...patch
}: { id: string } & ConnectionsPatchInput): Promise<ConnectionSummary> {
  return apiFetch<ConnectionSummary>(`/api/connections/${id}`, {
    method: "PATCH",
    json: patch,
  });
}

/** DELETE /api/connections/[id]. */
export function deleteConnection(id: string): Promise<DeleteConnectionResult> {
  return apiFetch<DeleteConnectionResult>(`/api/connections/${id}`, {
    method: "DELETE",
  });
}

/** Successful DELETE returns `{ ok, id }` so the cache can drop the row
 *  without a follow-up GET. */
export interface DeleteConnectionResult {
  ok: true;
  id: string;
}

// ─── hooks ───────────────────────────────────────────────────────────────

/** GET /api/connections — list the user's connections (masked summary). */
export function useConnections(): UseQueryResult<
  ConnectionSummary[],
  ApiClientError | Error
> {
  return useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: fetchConnections,
  });
}

/** POST /api/connections — create a connection. Triggers an R2 probe
 *  server-side, so `ApiClientError` with `code === "connection.invalid_credentials"`
 *  means the user-supplied keys were rejected by Cloudflare (vs. our own
 *  auth, which would be `auth.unauthorized`). */
export function useCreateConnection(): UseMutationResult<
  ConnectionSummary,
  ApiClientError | Error,
  ConnectionsCreateInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createConnection,
    onSuccess: (created) => {
      // Prepend so the newest connection is visible immediately — the
      // server's GET returns rows in DB-insertion order, so this matches
      // what the refetch will produce.
      queryClient.setQueryData<ConnectionSummary[]>(
        CONNECTIONS_QUERY_KEY,
        (prev) => (prev ? [created, ...prev] : [created]),
      );
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    },
  });
}

/** PATCH /api/connections/[id] — rename only. Server rejects any other
 *  field via the strict Zod schema, so the input type pins this down. */
export function useUpdateConnection(): UseMutationResult<
  ConnectionSummary,
  ApiClientError | Error,
  { id: string } & ConnectionsPatchInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateConnection,
    onSuccess: (updated) => {
      queryClient.setQueryData<ConnectionSummary[]>(
        CONNECTIONS_QUERY_KEY,
        (prev) => prev?.map((c) => (c.id === updated.id ? updated : c)),
      );
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    },
  });
}

/** DELETE /api/connections/[id]. Server returns 409 connection.in_use
 *  when there are unexpired shares pointing at this connection — surface
 *  that distinctly in the UI ("delete shares first") rather than treating
 *  it as a generic failure. */
export function useDeleteConnection(): UseMutationResult<
  DeleteConnectionResult,
  ApiClientError | Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: ({ id }) => {
      queryClient.setQueryData<ConnectionSummary[]>(
        CONNECTIONS_QUERY_KEY,
        (prev) => prev?.filter((c) => c.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    },
  });
}
