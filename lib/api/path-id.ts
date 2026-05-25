// lib/api/path-id.ts
//
// `withApi` narrows route handlers to a single `(req) => Response` signature,
// which hides Next.js 15's dynamic-route params context. Routes re-derive
// path segments from `req.url`; this helper is the one canonical spelling.
//
// Returns "" when the path is too short — callers are expected to Zod-validate
// the result (e.g. `ShareIdParamSchema.parse({ id })`), which surfaces a
// missing/garbled id as `validation.invalid` instead of throwing a raw
// TypeError.

import "server-only";

/** Get the path segment at `offsetFromEnd` (0 = last, 1 = second-to-last, …). */
export function pathSegmentFromEnd(url: string, offsetFromEnd: number): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1 - offsetFromEnd] ?? "";
}
