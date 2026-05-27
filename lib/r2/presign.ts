// lib/r2/presign.ts
//
// Presign helpers for the three R2 operations the browser performs
// directly against R2 instead of round-tripping through our edge:
//
//   - presignPut          → upload one object via single PUT
//   - presignGet          → download one object
//   - presignUploadPart   → upload one part of a multipart upload
//
// Why presign at all (rather than proxy):
//   CLAUDE.md security invariant #3 — all object I/O is direct
//   browser↔R2. Our worker mints the URL, then steps out of the data
//   path. This keeps us inside Pages' request-size limit and avoids
//   egress through our edge.
//
// Why these helpers are tiny:
//   The @aws-sdk/client-s3 package is enormous; Pages caps a worker
//   bundle at 1 MB (CLAUDE.md "Gotchas"). Importing only the three
//   Command classes we actually sign keeps the edge bundle in budget.
//   If you need a fourth operation, add a new helper here rather than
//   pulling in `* as S3` somewhere downstream.
//
// What this file does NOT do:
//   - It does NOT construct an S3Client — lib/r2/client.ts owns that.
//   - It does NOT decrypt credentials — route handlers do, in memory,
//     for the lifetime of one call.
//   - It does NOT log presigned URLs. They are short-lived bearer
//     tokens; treating them as printable data is the same mistake as
//     logging a session cookie.

import "server-only";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { mapR2Error } from "./errors";

// Fail fast in the route layer rather than letting the SDK build a
// malformed URL several frames deep. Mirrors the pattern in client.ts.
function requireNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`presign: ${field} must be a non-empty string`);
  }
}

// Positive integer specifically — fractional seconds make no sense for
// `expiresIn`, and negative/zero values would mint an already-expired
// URL that R2 silently rejects with a 403 (very confusing to debug).
function requirePositiveInt(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`presign: ${field} must be a positive integer`);
  }
}

export interface PresignPutParams {
  client: S3Client;
  bucket: string;
  key: string;
  /** Seconds until the signature expires. Positive integer. */
  ttl: number;
  /** If set, baked into the signature — the browser MUST send the same
   *  Content-Type header on PUT or R2 returns SignatureDoesNotMatch. */
  contentType?: string;
}

export interface PresignGetParams {
  client: S3Client;
  bucket: string;
  key: string;
  ttl: number;
}

export interface PresignUploadPartParams {
  client: S3Client;
  bucket: string;
  key: string;
  uploadId: string;
  /** Part index, 1-based per the S3 multipart API. */
  partNumber: number;
  ttl: number;
}

export async function presignPut(params: PresignPutParams): Promise<string> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");
  requirePositiveInt(params?.ttl, "ttl");

  // Conditional spread (instead of always passing ContentType: undefined)
  // keeps the signed payload identical between "caller didn't specify"
  // and "caller passed undefined" — easier to diff signatures while
  // debugging a SignatureDoesNotMatch.
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ...(params.contentType !== undefined
      ? { ContentType: params.contentType }
      : {}),
  });

  try {
    return await getSignedUrl(params.client, cmd, {
      expiresIn: params.ttl,
    });
  } catch (err) {
    throw mapR2Error(err);
  }
}

export async function presignGet(params: PresignGetParams): Promise<string> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");
  requirePositiveInt(params?.ttl, "ttl");

  const cmd = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
  });

  try {
    return await getSignedUrl(params.client, cmd, {
      expiresIn: params.ttl,
    });
  } catch (err) {
    throw mapR2Error(err);
  }
}

export async function presignUploadPart(
  params: PresignUploadPartParams,
): Promise<string> {
  requireNonEmpty(params?.bucket, "bucket");
  requireNonEmpty(params?.key, "key");
  requireNonEmpty(params?.uploadId, "uploadId");
  requirePositiveInt(params?.partNumber, "partNumber");
  requirePositiveInt(params?.ttl, "ttl");

  const cmd = new UploadPartCommand({
    Bucket: params.bucket,
    Key: params.key,
    UploadId: params.uploadId,
    PartNumber: params.partNumber,
  });

  try {
    return await getSignedUrl(params.client, cmd, {
      expiresIn: params.ttl,
    });
  } catch (err) {
    throw mapR2Error(err);
  }
}
