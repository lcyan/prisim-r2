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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  ObjectTable,
  type ObjectRow,
  type RowAction,
} from "@/components/features/files/object-table";
import { DeleteDialog } from "@/components/features/files/delete-dialog";
import { PreviewDialog } from "@/components/features/files/preview-dialog";
import { ShareDialog } from "@/components/features/share/share-dialog";
import { Dropzone } from "@/components/features/upload/dropzone";
import { ConfirmUploadCard } from "@/components/features/upload/confirm-upload-card";
import {
  useObjects,
  useObjectsItems,
  useLoadAllObjects,
} from "@/hooks/use-objects";
import { useMkdirMutation } from "@/hooks/use-mkdir";
import { useDownloadObject } from "@/hooks/use-download";
import { ApiClientError } from "@/lib/api/client";
import { ApiErrorCode } from "@/lib/api/errors";
import { useActiveConnectionStore } from "@/stores/active-connection";
import {
  useSelectedKeysStore,
  useSelectedKeysCount,
} from "@/stores/selected-keys";
import { useUploadQueueStore } from "@/stores/upload-queue";
import { joinPrefix, segmentsToPrefix } from "@/lib/r2/prefix";
import {
  keyForQueuedFile,
  type QueuedFile,
} from "@/lib/uploads/dropzone-utils";

const T = {
  pickConnection: "在顶部选择一个连接后即可浏览此 bucket。",
  downloadFailed: "无法开始下载",
  noFilesSelected: "未选择文件",
  bulkSkipsFolders: "批量删除会跳过文件夹。请进入文件夹后再选择其中的文件。",
  tooManyDownloads: "下载请求过多。请稍候再试。",
  connectionMissing: "找不到连接。请到「连接管理」重新添加。",
  errUnknown: "未知错误",
  mkdirAlreadyExists: "文件夹已存在",
  mkdirCreated: (name: string) => `已创建 ${name}/`,
  mkdirFailed: "无法创建文件夹",
  uploadEnqueued: (n: number) => `已入队 ${n} 个文件`,
} as const;

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
  const selectedKeys = useSelectedKeysStore((s) => s.selectedKeys);

  // Local UI state for the delete confirmation flow. `pendingDelete` holds
  // the keys the dialog is currently confirming; null = closed. We don't
  // route this through the Zustand store because it's strictly per-page
  // ephemeral and doesn't survive a route change anyway.
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  // Pending share: the object key to mint a presigned URL for; null when
  // the dialog is closed. Single-key state — the row Share button drives
  // it (there's no bulk-share flow).
  const [pendingShare, setPendingShare] = useState<string | null>(null);
  // Pending preview: row metadata (key + size) needed by PreviewDialog
  // to decide whether to show the large-image skeleton. null = closed.
  // We keep size alongside key because re-deriving it from `items`
  // would race the dialog open against a stale listing after a delete.
  const [pendingPreview, setPendingPreview] = useState<{
    key: string;
    size: number | null;
  } | null>(null);

  // View selectors derived from the infinite query. `useObjectsItems` strips
  // the 0-byte placeholder for the current prefix and flattens prefixes/files
  // into one row list. `useLoadAllObjects` drives `fetchNextPage` in a
  // bounded loop (cap is enforced inside the hook).
  const query = useObjects({ cid, bucket, prefix });
  const view = useObjectsItems(query, prefix);
  const loadAll = useLoadAllObjects(query);
  const { error, isPending, isError, fetchNextPage, refetch } = query;

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

  // Single-file download. The hook itself only mints a presigned GET URL
  // and hands it to the browser's native download manager — toast surface
  // lives here so the page can branch on ApiClientError.code without
  // dragging UI plumbing into the hook (matches use-connections.ts).
  const downloadMutation = useDownloadObject();
  const onRowAction = useCallback(
    (action: RowAction, row: ObjectRow) => {
      if (action === "delete") {
        // Per-row delete shares the dialog with the bulk-delete button —
        // both end up in `pendingDelete`. Folder rows can't reach this
        // branch (RowActions only renders for file rows) but defensive
        // filter avoids a confused delete on a "prefix/" key.
        if (row.kind !== "file") return;
        setPendingDelete([row.key]);
        return;
      }
      if (action === "share") {
        // Open the Share dialog scoped to this object. Folder rows can't
        // hit this branch (RowActions only renders for file rows) and the
        // server's ObjectKey schema would reject a leading-slash anyway —
        // the explicit guard keeps the defense in depth.
        if (row.kind !== "file") return;
        setPendingShare(row.key);
        return;
      }
      if (action === "preview") {
        // Same defense as Share — folder rows can't reach this code path
        // through the UI, but a leading "/" key would break the dialog.
        if (row.kind !== "file") return;
        setPendingPreview({ key: row.key, size: row.size });
        return;
      }
      if (action !== "download") {
        // Any remaining row action falls through here. Keep the no-op so
        // the buttons stay keyboard-reachable rather than appearing
        // disabled — see RowActions in object-table.tsx.
        return;
      }
      // Folder rows don't expose a Download button (RowActions only renders
      // for file rows), but defensive: don't presign a phantom key.
      if (row.kind !== "file" || !cid) return;
      downloadMutation.mutate(
        { cid, bucket, key: row.key },
        {
          onError: (err) => {
            toast.error(T.downloadFailed, {
              description: describeDownloadError(err),
            });
          },
        },
      );
    },
    [downloadMutation, cid, bucket],
  );

  // Bulk delete: feed the dialog only the file-like keys from the current
  // selection. Folder selections (entries ending in "/") are skipped — V1
  // delete is non-recursive, so trying to delete "logs/" would be a no-op
  // anyway. The user can clear the folder selection and re-pick the
  // contents if they want to drop a whole prefix.
  const onBulkDelete = useCallback(() => {
    const fileKeys = Array.from(selectedKeys).filter((k) => !k.endsWith("/"));
    if (fileKeys.length === 0) {
      toast.info(T.noFilesSelected, {
        description: T.bulkSkipsFolders,
      });
      return;
    }
    setPendingDelete(fileKeys);
  }, [selectedKeys]);

  // Mkdir: invoked by the ObjectTable toolbar. On success the mutation hook
  // invalidates the parent-prefix listing so the new folder row appears
  // without an extra refetch from here.
  const mkdir = useMkdirMutation();
  const handleMkdir = useCallback(
    (name: string) => {
      if (!cid) return;
      mkdir.mutate(
        { cid, bucket, parentPrefix: prefix, name },
        {
          onSuccess: (data) => {
            toast.success(
              data.alreadyExisted ? T.mkdirAlreadyExists : T.mkdirCreated(name),
            );
          },
          onError: (err) => {
            toast.error(T.mkdirFailed, {
              description: err instanceof Error ? err.message : T.errUnknown,
            });
          },
        },
      );
    },
    [cid, bucket, prefix, mkdir],
  );

  // Upload commit: fired by ConfirmUploadCard after the user confirms the
  // staging modal. Hands every accepted QueuedFile to the upload-queue store;
  // the dispatcher subscribes to the queue and starts the actual transfers.
  // `keyForQueuedFile` already encodes the chosen target prefix + relative
  // folder path so a folder drop preserves its tree.
  const enqueueMany = useUploadQueueStore((s) => s.enqueueMany);
  const handleUploadCommit = useCallback(
    (args: { accepted: QueuedFile[]; targetPrefix: string }) => {
      if (!cid) return;
      enqueueMany(
        cid,
        bucket,
        args.accepted.map((qf) => qf.file),
        (file) => {
          const matching = args.accepted.find((qf) => qf.file === file);
          return matching
            ? keyForQueuedFile(args.targetPrefix, matching)
            : `${args.targetPrefix}${file.name}`;
        },
      );
      toast.success(T.uploadEnqueued(args.accepted.length));
    },
    [cid, bucket, enqueueMany],
  );

  // While a connection is required to fetch anything useful, render the
  // breadcrumb anyway so the user understands the route + can use the
  // bucket-switcher control to pick a connection first.
  if (!cid) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <div className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          {T.pickConnection}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      {/* Dropzone wraps the table so a drag anywhere over the listing
          drops into the current prefix. Browse button + hint render
          above the table from inside the component. */}
      <Dropzone cid={cid} bucket={bucket} prefix={prefix}>
        <ObjectTable
          // `view.items` is `ObjectsItemRow[]` from hooks/use-objects.ts.
          // It is structurally identical to `ObjectRow` here (kind + key,
          // file rows also carry size + lastModified) but the two types
          // live on opposite sides of an import boundary today. Task 9/17
          // documented the duplicate; collapsing it is a future cleanup.
          items={view.items as unknown as ObjectRow[]}
          total={view.total}
          isLoading={isPending}
          isError={isError}
          errorMessage={error?.message ?? null}
          onRetry={() => void refetch()}
          onFolderClick={onFolderClick}
          onAction={onRowAction}
          onBulkDelete={onBulkDelete}
          hasNextPage={view.hasNext}
          isFetchingNextPage={view.isFetchingNext}
          onLoadMore={() => void fetchNextPage()}
          onMkdir={handleMkdir}
          onLoadAll={() => void loadAll.loadAll()}
          onStopLoadAll={loadAll.stop}
          isLoadingAll={loadAll.isLoadingAll}
          selectedCount={selectedCount}
          onClearSelection={clearSelection}
        />
      </Dropzone>
      <ConfirmUploadCard
        cid={cid}
        bucket={bucket}
        onCommit={handleUploadCommit}
      />
      <DeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        cid={cid}
        bucket={bucket}
        prefix={prefix}
        keys={pendingDelete ?? []}
        onDeleted={(deletedKeys) => {
          // After R2 confirms, drop the deleted keys from the selection
          // so the banner count reflects what's actually left. The
          // listing itself is invalidated by the hook's onSuccess.
          if (deletedKeys.length === 0) return;
          const remaining = new Set(selectedKeys);
          for (const k of deletedKeys) remaining.delete(k);
          // `setSelection` replaces the Set wholesale — pass the trimmed
          // list back. Empty arrays are fine; it's equivalent to clear().
          useSelectedKeysStore.getState().setSelection(Array.from(remaining));
        }}
      />
      <ShareDialog
        open={pendingShare !== null}
        onOpenChange={(open) => {
          if (!open) setPendingShare(null);
        }}
        cid={cid}
        bucket={bucket}
        objectKey={pendingShare ?? ""}
      />
      <PreviewDialog
        open={pendingPreview !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPreview(null);
        }}
        cid={cid}
        bucket={bucket}
        objectKey={pendingPreview?.key ?? ""}
        size={pendingPreview?.size ?? null}
      />
    </div>
  );
}

/** Translate the typed download error into a one-line toast description.
 *  Branching on `code` (not `status`) so future renames of an HTTP status
 *  don't silently regress the messaging. */
function describeDownloadError(err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case ApiErrorCode.AuthUnauthorized:
        // Two distinct causes share this code: OUR session expired, OR R2
        // rejected the user's stored keys. The route's message ("R2
        // credentials rejected") disambiguates — include it verbatim.
        return `${err.message} (request ${err.requestId})`;
      case ApiErrorCode.RateLimited:
        return T.tooManyDownloads;
      case ApiErrorCode.NotFound:
        return T.connectionMissing;
      default:
        return `${err.code} — ${err.message} (request ${err.requestId})`;
    }
  }
  if (err instanceof Error) return err.message;
  return T.errUnknown;
}
