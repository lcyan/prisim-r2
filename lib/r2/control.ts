// lib/r2/control.ts
//
// Server-side wrappers for the R2/S3 control-plane calls our app makes
// directly (i.e. NOT object body I/O — those go through presign.ts and
// happen browser↔R2). Each wrapper:
//   - takes a per-request S3Client built by lib/r2/client.ts
//   - validates input cheaply and fails fast with TypeError (programmer
//     bug, not an upstream issue — see presign.ts for the same pattern)
//   - calls exactly one Command class (kept tight for the edge bundle —
//     CLAUDE.md "Gotchas": @aws-sdk/client-s3 is heavy)
//   - routes upstream failures through mapR2Error so route handlers get
//     a clean R2CredentialError vs R2UpstreamError split
//
// Why this file exists alongside presign.ts:
//   Presigning happens entirely client-side after we mint the URL — no
//   network round-trip from our worker. Control-plane calls (list,
//   delete, multipart bookkeeping) DO go through our worker and need
//   per-call error mapping + result normalization. Keeping the two
//   files apart makes the "does this touch object bytes?" question one
//   glance instead of one search.
//
// What this file deliberately does NOT do:
//   - It does NOT proxy object bytes. PutObject / GetObject body I/O
//     happens via presigned URLs in presign.ts (CLAUDE.md security
//     invariant #3). If you find yourself adding a body field here,
//     stop and add a presign helper instead.
//   - It does NOT enforce destructive-confirmation. deleteObjects just
//     deletes what it's told; the confirmation-token contract is a
//     route-layer concern (CLAUDE.md security invariant #4).

import "server-only";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { mapR2Error } from "./errors";

// S3 DeleteObjects caps at 1000 keys per request — exceeding it returns
// MalformedXML, which is opaque from the route layer. We chunk inside
// the wrapper so callers can pass arbitrarily large lists without
// thinking about the boundary.
const DELETE_BATCH_LIMIT = 1000;

// Mirrors the helpers in presign.ts. Inlined rather than extracted to a
// shared _validate.ts because we have exactly two call sites; a third
// module needing them is the trigger to lift this into its own file.
function requireNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`r2/control: ${field} must be a non-empty string`);
  }
}

function requirePositiveInt(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`r2/control: ${field} must be a positive integer`);
  }
}

// ─── listObjects ────────────────────────────────────────────────────────

export interface ListObjectsParams {
  client: S3Client;
  bucket: string;
  prefix?: string;
  /** Cursor from a previous response. R2 uses opaque tokens — do not
   *  try to interpret. Pass through verbatim. */
  continuationToken?: string;
  /** R2 caps at 1000 per page by default; positive integer if set. */
  maxKeys?: number;
  /** S3 grouping separator — pass "/" to fold deeper keys into
   *  CommonPrefixes (folder-style listing). Omit for a flat listing
   *  (every key returned individually). */
  delimiter?: string;
}

export interface ListObjectsItem {
  key: string;
  size?: number;
  etag?: string;
  lastModified?: Date;
}

export interface ListObjectsResult {
  items: ListObjectsItem[];
  /** Common-prefix strings returned when `delimiter` is set (folder-like
   *  groupings). Always an array — empty when `delimiter` was omitted or
   *  R2 returned no CommonPrefixes. Each entry is the literal `Prefix`
   *  string R2 returned (already includes the delimiter). */
  prefixes: string[];
  /** Token for the next page, or undefined if this was the last page. */
  continuationToken?: string;
  isTruncated: boolean;
}

export async function listObjects(
  params: ListObjectsParams,
): Promise<ListObjectsResult> {
  requireNonEmpty(params?.bucket, "bucket");
  if (params.maxKeys !== undefined) {
    requirePositiveInt(params.maxKeys, "maxKeys");
  }
  if (params.delimiter !== undefined) {
    requireNonEmpty(params.delimiter, "delimiter");
  }

  try {
    const res = await params.client.send(
      new ListObjectsV2Command({
        Bucket: params.bucket,
        Prefix: params.prefix,
        ContinuationToken: params.continuationToken,
        MaxKeys: params.maxKeys,
        Delimiter: params.delimiter,
      }),
    );

    // S3 sometimes returns Contents entries without a Key on edge cases
    // (e.g. delete markers in versioned buckets). R2 doesn't version,
    // but the type is `Key?: string` so we filter to be safe rather
    // than emit items with `key: ""`.
    const items: ListObjectsItem[] = [];
    for (const obj of res.Contents ?? []) {
      if (typeof obj.Key !== "string" || obj.Key.length === 0) continue;
      items.push({
        key: obj.Key,
        size: obj.Size,
        etag: obj.ETag,
        lastModified: obj.LastModified,
      });
    }

    // CommonPrefixes is only populated when Delimiter is supplied. The
    // SDK types each entry's Prefix as optional, so we filter (same
    // defensive pattern as Contents) rather than emit "" sentinels.
    const prefixes: string[] = [];
    for (const cp of res.CommonPrefixes ?? []) {
      if (typeof cp.Prefix === "string" && cp.Prefix.length > 0) {
        prefixes.push(cp.Prefix);
      }
    }

    return {
      items,
      prefixes,
      continuationToken: res.NextContinuationToken,
      isTruncated: res.IsTruncated ?? false,
    };
  } catch (err) {
    throw mapR2Error(err);
  }
}

// ─── summarizeBucketUsage ───────────────────────────────────────────────

export interface SummarizeBucketUsageParams {
  client: S3Client;
  bucket: string;
  maxObjects: number;
  maxPages: number;
}

export interface SummarizeBucketUsageResult {
  objectCount: number;
  totalBytes: number;
  truncated: boolean;
}

export async function summarizeBucketUsage(
  params: SummarizeBucketUsageParams,
): Promise<SummarizeBucketUsageResult> {
  requireNonEmpty(params?.bucket, "bucket");
  requirePositiveInt(params.maxObjects, "maxObjects");
  requirePositiveInt(params.maxPages, "maxPages");

  let continuationToken: string | undefined;
  let objectCount = 0;
  let totalBytes = 0;
  let pages = 0;
  let truncated = false;

  try {
    do {
      pages += 1;
      const res = await params.client.send(
        new ListObjectsV2Command({
          Bucket: params.bucket,
          ContinuationToken: continuationToken,
          MaxKeys: Math.min(1000, params.maxObjects - objectCount),
        }),
      );

      for (const obj of res.Contents ?? []) {
        if (typeof obj.Key !== "string" || obj.Key.length === 0) continue;
        if (objectCount >= params.maxObjects) {
          truncated = true;
          break;
        }
        objectCount += 1;
        totalBytes += typeof obj.Size === "number" ? obj.Size : 0;
      }

      continuationToken = res.NextContinuationToken;
      if (res.IsTruncated && continuationToken && objectCount < params.maxObjects) {
        truncated = pages >= params.maxPages;
      } else {
        truncated = Boolean(res.IsTruncated && continuationToken);
      }
    } while (
      continuationToken &&
      objectCount < params.maxObjects &&
      pages < params.maxPages
    );

    if (continuationToken && (objectCount >= params.maxObjects || pages >= params.maxPages)) {
      truncated = true;
    }

    return { objectCount, totalBytes, truncated };
  } catch (err) {
    throw mapR2Error(err);
  }
}

// ─── deleteObjects ──────────────────────────────────────────────────────

export interface DeleteObjectsParams {
  client: S3Client;
  bucket: string;
  keys: string[];
}

export interface DeleteObjectsError {
  key?: string;
  code?: string;
  message?: string;
}

export interface DeleteObjectsResult {
  deleted: string[];
  errors: DeleteObjectsError[];
}

export async function deleteObjects(
  params: DeleteObjectsParams,
): Promise<DeleteObjectsResult> {
  requireNonEmpty(params?.bucket, "bucket");
  if (!Array.isArray(params?.keys)) {
    throw new TypeError("r2/control: keys must be an array");
  }
  // Empty list is a no-op rather than an error: callers building up a
  // selection naturally hit this when nothing is checked, and we want
  // the UI not to need an "if (selected.length > 0)" guard.
  if (params.keys.length === 0) {
    return { deleted: [], errors: [] };
  }

  const deleted: string[] = [];
  const errors: DeleteObjectsError[] = [];

  for (let i = 0; i < params.keys.length; i += DELETE_BATCH_LIMIT) {
    const batch = params.keys.slice(i, i + DELETE_BATCH_LIMIT);
    try {
      const res = await params.client.send(
        new DeleteObjectsCommand({
          Bucket: params.bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            // Default Quiet=false; we want per-key Deleted/Errors back
            // so the UI can surface partial failures.
          },
        }),
      );
      for (const d of res.Deleted ?? []) {
        if (typeof d.Key === "string") deleted.push(d.Key);
      }
      for (const e of res.Errors ?? []) {
        errors.push({ key: e.Key, code: e.Code, message: e.Message });
      }
    } catch (err) {
      // Per-batch try/catch: a credential failure on batch N would
      // otherwise discard the successful deletes from batches 1..N-1.
      // We still re-throw because the caller almost always wants
      // all-or-nothing semantics on a credential error (re-auth then
      // retry), but at least the route layer sees the original code.
      throw mapR2Error(err);
    }
  }

  return { deleted, errors };
}

// ─── createMultipartUpload ──────────────────────────────────────────────

export interface CreateMultipartUploadParams {
  client: S3Client;
  bucket: string;
  key: string;
  contentType?: string;
}

export interface CreateMultipartUploadResult {
  uploadId: string;
}

export async function createMultipartUpload(
  params: CreateMultipartUploadParams,
): Promise<CreateMultipartUploadResult> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");

  try {
    const res = await params.client.send(
      new CreateMultipartUploadCommand({
        Bucket: params.bucket,
        Key: params.key,
        ...(params.contentType !== undefined
          ? { ContentType: params.contentType }
          : {}),
      }),
    );
    // R2 always returns an UploadId on success, but the SDK types it as
    // optional. If it's missing, something is very wrong upstream and
    // we want a loud error instead of a silent "" propagating into
    // every subsequent UploadPart/Complete call.
    if (typeof res.UploadId !== "string" || res.UploadId.length === 0) {
      throw new Error("R2 createMultipartUpload returned no UploadId");
    }
    return { uploadId: res.UploadId };
  } catch (err) {
    throw mapR2Error(err);
  }
}

// ─── completeMultipartUpload ────────────────────────────────────────────

export interface CompleteMultipartUploadParams {
  client: S3Client;
  bucket: string;
  key: string;
  uploadId: string;
  /** Each part: 1-based partNumber + ETag returned from the UploadPart
   *  presigned PUT response. Order does not matter on input; we sort. */
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface CompleteMultipartUploadResult {
  etag?: string;
  location?: string;
}

export async function completeMultipartUpload(
  params: CompleteMultipartUploadParams,
): Promise<CompleteMultipartUploadResult> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");
  requireNonEmpty(params?.uploadId, "uploadId");
  if (!Array.isArray(params?.parts) || params.parts.length === 0) {
    throw new TypeError("r2/control: parts must be a non-empty array");
  }
  for (const p of params.parts) {
    requirePositiveInt(p?.partNumber, "parts[].partNumber");
    requireNonEmpty(p?.etag, "parts[].etag");
  }

  // S3 requires parts in ascending partNumber order or it returns
  // InvalidPartOrder. Sorting here means the browser can collect ETags
  // in whatever order the parallel uploads finish without worrying.
  // Copy first so we don't mutate the caller's array.
  const sortedParts = [...params.parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));

  try {
    const res = await params.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: params.bucket,
        Key: params.key,
        UploadId: params.uploadId,
        MultipartUpload: { Parts: sortedParts },
      }),
    );
    return { etag: res.ETag, location: res.Location };
  } catch (err) {
    throw mapR2Error(err);
  }
}

// ─── abortMultipartUpload ───────────────────────────────────────────────

export interface AbortMultipartUploadParams {
  client: S3Client;
  bucket: string;
  key: string;
  uploadId: string;
}

export async function abortMultipartUpload(
  params: AbortMultipartUploadParams,
): Promise<void> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");
  requireNonEmpty(params?.uploadId, "uploadId");

  try {
    await params.client.send(
      new AbortMultipartUploadCommand({
        Bucket: params.bucket,
        Key: params.key,
        UploadId: params.uploadId,
      }),
    );
  } catch (err) {
    throw mapR2Error(err);
  }
}

// ─── listBuckets ────────────────────────────────────────────────────────

export interface ListBucketsParams {
  client: S3Client;
}

export interface BucketSummary {
  name?: string;
  creationDate?: Date;
}

export async function listBuckets(
  params: ListBucketsParams,
): Promise<BucketSummary[]> {
  try {
    const res = await params.client.send(new ListBucketsCommand({}));
    return (res.Buckets ?? []).map((b) => ({
      name: b.Name,
      creationDate: b.CreationDate,
    }));
  } catch (err) {
    throw mapR2Error(err);
  }
}

// ─── putEmptyObject ──────────────────────────────────────────────────────
//
// Used by POST /api/r2/mkdir. Writes a 0-byte object with the given key
// (typically `<prefix>/`), making the prefix appear as a "folder" in
// list responses (R2 returns it under CommonPrefixes when Delimiter='/').
//
// Idempotent: HeadObject probe first. If the object already exists we
// return without re-writing — gives callers a "already created" signal
// rather than masking it as "created".
//
// Why HeadObject + PutObject rather than IfNoneMatch:"*"
//   R2 has variable support for PutObject conditional headers and the
//   error coming back via the SDK isn't uniform across versions. Two
//   round-trips are fine here — mkdir is not on a hot path.

export interface PutEmptyObjectParams {
  client: S3Client;
  bucket: string;
  key: string;
}

export interface PutEmptyObjectResult {
  alreadyExisted: boolean;
}

export async function putEmptyObject(
  params: PutEmptyObjectParams,
): Promise<PutEmptyObjectResult> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");

  // 1. Probe.
  try {
    await params.client.send(
      new HeadObjectCommand({ Bucket: params.bucket, Key: params.key }),
    );
    return { alreadyExisted: true };
  } catch (err) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
        ?.httpStatusCode ?? 0;
    if (status !== 404) {
      // 403 / 401 → R2CredentialError; 5xx → R2UpstreamError.
      throw mapR2Error(err);
    }
    // Fall-through to PUT.
  }

  // 2. Write 0-byte object.
  try {
    await params.client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: new Uint8Array(0),
        ContentLength: 0,
      }),
    );
    return { alreadyExisted: false };
  } catch (err) {
    throw mapR2Error(err);
  }
}
