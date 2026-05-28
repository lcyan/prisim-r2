// hooks/use-upload-conflicts.ts
//
// MVP conflict detection for the confirm-upload modal. Reads whatever
// pages of the target prefix are already in the TanStack Query cache and
// computes the set of queuedKeys that would overwrite an existing object.
//
// Why this is "best-effort" (cache-only, no HEAD requests):
//   We deliberately do NOT issue 200 HEAD requests for a 200-file folder
//   upload. The cache covers the 80% case where the user just navigated
//   to the target prefix and is uploading into it. When the cache is
//   empty OR shows nextCursor !== null on any page, we surface
//   `hasUncheckedDepth = true` so the modal can render a warning like
//   "files we haven't loaded may also exist".
//
// The hook is read-only: no fetch, no invalidation. Pairs with
// `useObjects(...)` — that hook populates the cache; this one consumes it.

import { useMemo } from "react";
import {
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

import { objectsQueryKey } from "@/hooks/use-objects";
import type { R2ListResponse } from "@/lib/api/types";

export interface UseUploadConflictsArgs {
  cid: string | null | undefined;
  bucket: string | null | undefined;
  /** "" (root) or ends with "/". The query key uses this verbatim. */
  targetPrefix: string;
  /** Full R2 keys the user is about to upload (already path-resolved). */
  queuedKeys: string[];
}

export interface UseUploadConflictsResult {
  /** Subset of `queuedKeys` that match an object already in the cache. */
  conflictKeys: Set<string>;
  /** True when the cache could NOT have spotted every possible conflict:
   *  either no cache exists for the prefix, or the cache reports more
   *  pages remain server-side. */
  hasUncheckedDepth: boolean;
}

export function useUploadConflicts(
  args: UseUploadConflictsArgs,
): UseUploadConflictsResult {
  const qc = useQueryClient();

  return useMemo<UseUploadConflictsResult>(() => {
    // Hook idles until both cid and bucket are present (matches useObjects).
    if (!args.cid || !args.bucket) {
      return { conflictKeys: new Set<string>(), hasUncheckedDepth: false };
    }

    const data = qc.getQueryData<
      InfiniteData<R2ListResponse, string | undefined>
    >(objectsQueryKey(args.cid, args.bucket, args.targetPrefix));

    // No cache → we couldn't have spotted any conflict, so depth is
    // unchecked. The caller's modal renders the warning.
    if (!data) {
      return { conflictKeys: new Set<string>(), hasUncheckedDepth: true };
    }

    const existing = new Set<string>();
    let hasUncheckedDepth = false;
    for (const page of data.pages) {
      if (page.nextCursor !== null) hasUncheckedDepth = true;
      for (const o of page.objects) existing.add(o.key);
    }

    const conflictKeys = new Set<string>();
    for (const k of args.queuedKeys) {
      if (existing.has(k)) conflictKeys.add(k);
    }
    return { conflictKeys, hasUncheckedDepth };
  }, [qc, args.cid, args.bucket, args.targetPrefix, args.queuedKeys]);
}
