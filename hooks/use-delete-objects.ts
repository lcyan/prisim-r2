// hooks/use-delete-objects.ts
//
// Two-step destructive object delete.
//
//   1. POST /api/r2/delete/prepare → { confirmToken, expiresAt }
//   2. POST /api/r2/delete         → { deleted, errors } (runs the deletion)
//
// Why two POSTs (and not one):
//   CLAUDE.md security invariant #4 requires every destructive op to carry
//   a server-verified confirmation token. The dialog UI also asks the user
//   to type the exact bucket name before enabling Delete — that's the human
//   ceremony; the HMAC token is the machine ceremony. Both must succeed.
//
// Why a single mutation that fires both calls in sequence (and not two
// separate mutations exposed to the UI):
//   The dialog opens AFTER the user has selected keys, so we already know
//   the full input. Splitting into "useDeletePrepare" + "useDeleteConfirm"
//   would force the caller to store the token in component state between
//   the two clicks and worry about expiry. Keeping the chain inside one
//   `mutate` call means the token never escapes this module — it's used
//   the instant it's minted and discarded on next mount.
//
// Conventions (mirror use-download.ts):
//   * Wire helpers exported as plain async functions so vitest can pin the
//     URL/method/payload without rendering React.
//   * No toast / error UI — `error` flows through the mutation state and
//     the page maps `ApiClientError.code` to user-facing copy.
//   * `onSuccess` invalidates the objects-listing query for the affected
//     prefix so the row disappears immediately after R2 confirms.
//
// What this file deliberately does NOT do:
//   * No retry: re-running a failed delete would re-mint a token and
//     re-run audit + rate-limit consumption. The UI shows the failure
//     and lets the user click again.
//   * No optimistic patch on the listing. R2 returns per-key partial
//     failures (AccessDenied, NoSuchKey), and optimistically removing a
//     row that didn't actually delete would mislead the user — invalidate
//     after success and let the server be the source of truth.

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type {
  R2DeletePrepareResponse,
  R2DeleteResponse,
} from "@/lib/api/types";
import { objectsQueryKey } from "@/hooks/use-objects";

/** Prefix-aware shape so the page can scope the listing invalidation. */
export interface DeleteObjectsInput {
  cid: string;
  bucket: string;
  /** The prefix the listing is currently scoped to — used only to
   *  invalidate the right TanStack Query cache entry on success. NOT sent
   *  to the server (the server deletes by literal key, not by prefix). */
  prefix: string;
  /** Full R2 keys to delete. Folder rows (entries ending in "/") MUST be
   *  filtered out by the caller — V1 is non-recursive and a delete on
   *  "logs/" would be a no-op at the upstream. */
  keys: string[];
}

/** POST /api/r2/delete/prepare — mint the confirmation token. Exported so
 *  unit tests can pin the wire shape without rendering the hook. */
export function requestDeletePrepare(input: {
  cid: string;
  bucket: string;
  keys: string[];
}): Promise<R2DeletePrepareResponse> {
  return apiFetch<R2DeletePrepareResponse>("/api/r2/delete/prepare", {
    method: "POST",
    json: input,
  });
}

/** POST /api/r2/delete — confirm the deletion with the minted token. */
export function requestDeleteConfirm(input: {
  cid: string;
  bucket: string;
  keys: string[];
  confirmToken: string;
}): Promise<R2DeleteResponse> {
  return apiFetch<R2DeleteResponse>("/api/r2/delete", {
    method: "POST",
    json: input,
  });
}

/**
 * Bulk-delete the given keys. Fires prepare → confirm in sequence and
 * invalidates the objects listing on success.
 *
 * Failure modes worth handling at the call site:
 *   * `auth.unauthorized`         — OUR session is gone. Bounce to /login.
 *   * `confirmation.required`     — token expired/tampered. Re-open dialog.
 *   * `connection.invalid_credentials` (mapped via R2CredentialError) —
 *                                    user's R2 keys are stale; re-add.
 *   * `rate_limited`              — show "wait N s, try again".
 *   * Partial failure (HTTP 200 with non-empty `errors`) is NOT raised as
 *     an exception — the resolved value carries both arrays so the caller
 *     can decide between "all good" and "show per-row failures".
 */
export function useDeleteObjects(): UseMutationResult<
  R2DeleteResponse,
  ApiClientError | Error,
  DeleteObjectsInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteObjectsInput) => {
      const { confirmToken } = await requestDeletePrepare({
        cid: input.cid,
        bucket: input.bucket,
        keys: input.keys,
      });
      return requestDeleteConfirm({
        cid: input.cid,
        bucket: input.bucket,
        keys: input.keys,
        confirmToken,
      });
    },
    onSuccess: (_result, input) => {
      // Re-fetch the affected listing. We don't optimistic-patch because
      // R2 may have returned partial failures; trusting the server's next
      // list is safer than guessing which keys actually went away.
      void queryClient.invalidateQueries({
        queryKey: objectsQueryKey(input.cid, input.bucket, input.prefix),
      });
    },
  });
}
