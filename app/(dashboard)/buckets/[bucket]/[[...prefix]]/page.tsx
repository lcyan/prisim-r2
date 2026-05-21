"use client";

// app/(dashboard)/buckets/[bucket]/[[...prefix]]/page.tsx
//
// Object browser route. Catch-all segment `[[...prefix]]` lets us encode the
// current folder in the URL itself rather than in a `?prefix=` query string,
// which means:
//   * the browser back / forward buttons restore the breadcrumb naturally,
//   * users can bookmark or share a deep folder,
//   * Next.js gives us the segments pre-parsed as `params.prefix: string[] | undefined`.
//
// All the data plumbing — useObjects, the breadcrumb component, the table,
// the selectedKeys store — lives outside this file. This page is the glue:
// it reads the URL, hands the prefix to the hook + UI, and wires navigation
// back to `router.push(...)`. Anything more complicated than that should go
// into a hook or a child component so the page stays readable.

import { useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";

import { FileBreadcrumb } from "@/components/features/files/breadcrumb";
import { ObjectTable } from "@/components/features/files/object-table";
import { useObjects } from "@/hooks/use-objects";
import { useActiveConnectionStore } from "@/stores/active-connection";
import {
  useSelectedKeysStore,
  useSelectedKeysCount,
} from "@/stores/selected-keys";
import {
  joinPrefix,
  prefixAtDepth,
  segmentsToPrefix,
} from "@/lib/r2/prefix";

/**
 * Build the path-only URL for `/buckets/<bucket>/<segments...>`. Used by every
 * navigation entry point on this page so the encoding rule (each segment
 * `encodeURIComponent`-ed individually, never the whole string) is enforced in
 * one place. R2 keys may legitimately contain spaces, '+' or '%'.
 */
function buildBrowseHref(bucket: string, prefix: string): string {
  const segments = prefix
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s));
  // `bucket` is validated upstream (BucketNameSchema: lowercase letters /
  // digits / '.' / '-'), but URL-encoding it costs nothing and stays
  // correct if the schema ever loosens.
  const head = `/buckets/${encodeURIComponent(bucket)}`;
  return segments.length === 0 ? head : `${head}/${segments.join("/")}`;
}

export default function BucketBrowserPage() {
  const router = useRouter();
  // useParams returns the values as `string | string[] | undefined`; the file
  // path here pins them: `bucket` is one segment, `prefix` is the catch-all
  // (string[] | undefined). We cast through `Record<string, ...>` rather than
  // declare a generic on useParams because next/navigation's TS surface for
  // generics on this hook is unstable.
  const params = useParams() as {
    bucket?: string;
    prefix?: string[];
  };
  const bucket = params.bucket ?? "";
  // Normalize the URL segments to an R2-style prefix string (trailing slash,
  // empty for root) — see lib/r2/prefix.ts for why.
  const prefix = useMemo(
    () => segmentsToPrefix(params.prefix),
    [params.prefix],
  );

  const cid = useActiveConnectionStore((s) => s.activeConnectionId);
  // Mirror the URL bucket into the active-connection store so the
  // BucketSwitcher in the dashboard header reflects the currently-browsed
  // bucket on a hard refresh / shared-link load. Only runs on the client.
  const setActiveBucket = useActiveConnectionStore((s) => s.setActiveBucket);
  useEffect(() => {
    if (bucket) setActiveBucket(bucket);
  }, [bucket, setActiveBucket]);

  // Clear cross-page multi-selection whenever the user navigates into a
  // different prefix (or bucket). selectedKeys are full R2 keys, so a key
  // selected at "a/b/" is meaningless at "a/c/". onPrefixChange() is a no-op
  // when the cookie/store already matches — see selected-keys.ts.
  const onPrefixChange = useSelectedKeysStore((s) => s.onPrefixChange);
  useEffect(() => {
    onPrefixChange({ bucket, prefix });
  }, [bucket, prefix, onPrefixChange]);

  const selectedCount = useSelectedKeysCount();
  const clearSelection = useSelectedKeysStore((s) => s.clear);

  const {
    data,
    error,
    isPending,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useObjects({ cid, bucket, prefix });

  // Flatten the paginated cache into one display list. Folders first (matches
  // the convention every cloud-storage UI uses) then files; both rendered as
  // rows by ObjectTable.
  const items = useMemo(() => {
    if (!data) return [];
    const folders = data.pages
      .flatMap((page) => page.prefixes)
      .map((p) => ({
        kind: "prefix" as const,
        key: p,
      }));
    const files = data.pages.flatMap((page) =>
      page.objects.map((o) => ({
        kind: "file" as const,
        key: o.key,
        size: o.size,
        lastModified: o.lastModified,
      })),
    );
    return [...folders, ...files];
  }, [data]);

  const handleNavigate = (target: string) => {
    // Three call sites for this handler:
    //   - row click on a folder → joinPrefix(prefix, child)
    //   - breadcrumb segment    → prefixAtDepth(prefix, depth)
    //   - breadcrumb "root"     → "" (passed through verbatim)
    // All three end up here so we have one place that maps R2-prefix → URL.
    router.push(buildBrowseHref(bucket, target));
  };

  const onFolderClick = (folderKey: string) => {
    handleNavigate(joinPrefix(prefix, folderKey));
  };
  const onBreadcrumbClick = (depth: number) => {
    handleNavigate(prefixAtDepth(prefix, depth));
  };

  // While a connection is required to fetch anything useful, render the
  // breadcrumb anyway so the user understands the route + can use the
  // bucket-switcher control to pick a connection first.
  if (!cid) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <FileBreadcrumb
          bucket={bucket}
          prefix={prefix}
          onNavigate={onBreadcrumbClick}
        />
        <div className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          Pick a connection in the header to browse this bucket.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <FileBreadcrumb
        bucket={bucket}
        prefix={prefix}
        onNavigate={onBreadcrumbClick}
      />
      <ObjectTable
        items={items}
        isLoading={isPending}
        isError={isError}
        errorMessage={error?.message ?? null}
        onRetry={() => void refetch()}
        onFolderClick={onFolderClick}
        hasNextPage={Boolean(hasNextPage)}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        selectedCount={selectedCount}
        onClearSelection={clearSelection}
      />
    </div>
  );
}
