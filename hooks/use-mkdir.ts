// hooks/use-mkdir.ts
//
// TanStack Query mutation hook for POST /api/r2/mkdir.
//
// On success the hook invalidates the listing for the *parent* prefix — so
// the new folder appears in the object table on next render. It does NOT
// invalidate the child prefix (the newly-created one), because nothing
// could have been cached there yet.
//
// Conventions (mirror use-delete-objects.ts):
//   * `requestMkdir` is exported as a plain async function so vitest can pin
//     the URL / method / payload without rendering React.
//   * `apiFetch` is called with `json:` rather than a pre-stringified `body`
//     so content-type is set and CSRF auto-injection runs.

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { apiFetch, ApiClientError } from "@/lib/api/client";
import type { R2MkdirResponse } from "@/lib/api/types";
import { objectsQueryKey } from "@/hooks/use-objects";

export interface MkdirInput {
  cid: string;
  bucket: string;
  /** "" or ends with "/" — the prefix the new folder will live UNDER. */
  parentPrefix: string;
  /** Single path segment; no slashes. The route also validates. */
  name: string;
}

export function requestMkdir(input: MkdirInput): Promise<R2MkdirResponse> {
  return apiFetch<R2MkdirResponse>("/api/r2/mkdir", {
    method: "POST",
    json: input,
  });
}

export function useMkdirMutation(): UseMutationResult<
  R2MkdirResponse,
  ApiClientError | Error,
  MkdirInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MkdirInput) => requestMkdir(input),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({
        queryKey: objectsQueryKey(input.cid, input.bucket, input.parentPrefix),
      });
    },
  });
}
