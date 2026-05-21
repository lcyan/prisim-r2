// lib/r2/prefix.ts
//
// Pure helpers for converting between the URL representation of an R2
// folder location and the S3-style `prefix` string the API expects.
//
// We keep three representations straight:
//   - URL: catch-all route segments under /buckets/[bucket]/[[...prefix]]
//     — e.g. for "/buckets/logs/2026/05/01" the segments are
//     ["2026", "05", "01"]. Empty path → undefined / [].
//   - Prefix (wire): the string sent to the R2 list endpoint as `prefix`.
//     Always either "" (root) or ends with "/" (so R2's Delimiter='/'
//     listing folds keys correctly). E.g. "2026/05/01/".
//   - Display segments: same as URL segments but normalized; used by the
//     breadcrumb to render each clickable hop.
//
// Why a separate module (not inline in the page):
//   - Pure functions are trivial to unit-test under vitest's node env —
//     no React tree required.
//   - The exact normalization rules show up in the page, the breadcrumb,
//     and the table's folder-navigation handler; centralizing them keeps
//     them from drifting.

/**
 * Convert URL catch-all segments to the wire `prefix` string the
 * `/api/r2/list` endpoint expects.
 *
 *   undefined       → ""           (root)
 *   []              → ""           (root)
 *   ["a", "b"]      → "a/b/"
 *   ["a", "", "b"]  → "a/b/"       (empty segments filtered — defensive)
 *   ["a/b"]         → "a/b/"       (slash already inside one segment)
 *
 * The trailing slash is invariant so the route can pipe `prefix` straight
 * into ListObjectsV2 with Delimiter='/' without an extra `?? ""` /
 * `endsWith('/')` dance at the callsite.
 */
export function segmentsToPrefix(
  segments: string[] | undefined,
): string {
  if (!segments || segments.length === 0) return "";
  const joined = segments
    .map((s) => decodeURIComponent(s))
    .filter((s) => s.length > 0)
    .join("/");
  if (joined.length === 0) return "";
  return joined.endsWith("/") ? joined : `${joined}/`;
}

/**
 * Inverse of segmentsToPrefix — turn an R2-style prefix into the catch-all
 * segments suitable for a `router.push(...)` target.
 *
 *   ""              → []
 *   "a/"            → ["a"]
 *   "a/b/c/"        → ["a", "b", "c"]
 *   "a/b/c"         → ["a", "b", "c"]   (trailing slash optional)
 *
 * Empty segments collapse — a stray "//" in user-supplied input would
 * otherwise produce a phantom empty crumb in the breadcrumb.
 */
export function prefixToSegments(prefix: string): string[] {
  if (!prefix) return [];
  return prefix.split("/").filter((s) => s.length > 0);
}

/**
 * Build the prefix for one level deeper, given the current prefix and the
 * name of the folder being entered. Mirrors what the table does when the
 * user clicks a "prefix" row.
 *
 *   ("",     "logs")  → "logs/"
 *   ("a/",   "b")     → "a/b/"
 *   ("a/b/", "c/")    → "a/b/c/"    (trailing slash on child tolerated)
 */
export function joinPrefix(parent: string, child: string): string {
  const clean = child.replace(/\/+$/u, "");
  if (!clean) return parent;
  if (!parent) return `${clean}/`;
  return parent.endsWith("/") ? `${parent}${clean}/` : `${parent}/${clean}/`;
}

/**
 * Build the prefix for one level shallower than `prefix`. Used by the
 * breadcrumb when the user clicks a segment higher in the tree.
 *
 *   ("a/b/c/", 0) → "a/"
 *   ("a/b/c/", 1) → "a/b/"
 *   ("a/b/c/", 2) → "a/b/c/"     (last index == full prefix)
 *
 * `depth` is 0-based and inclusive (`depth=0` keeps the first segment).
 * Passing -1 returns "" (root) so the bucket-name crumb works naturally.
 */
export function prefixAtDepth(prefix: string, depth: number): string {
  if (depth < 0) return "";
  const segments = prefixToSegments(prefix).slice(0, depth + 1);
  return segmentsToPrefix(segments);
}
