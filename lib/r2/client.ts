// lib/r2/client.ts
//
// Factory for per-request S3Client instances configured for Cloudflare R2.
//
// Why a factory (and why no caching):
//   - Multi-tenant: every API request decrypts ONE user's credentials and
//     uses them for ONE upstream call. Caching by accountId would mean
//     keys outlive the request and risk cross-tenant reuse if state ever
//     bled between requests.
//   - Cloudflare Pages/Workers isolates are short-lived anyway; an S3Client
//     does not own a connection pool we'd benefit from reusing.
//
// What this file deliberately does NOT do:
//   - It does NOT call mapR2Error. Client *construction* is purely local
//     config — there is no SDK round-trip to wrap. Command-level wrappers
//     in lib/r2/presign.ts and lib/r2/control.ts own that responsibility.
//   - It does NOT log or audit. Logging plaintext credentials anywhere —
//     even via console.error on a thrown TypeError — would violate the
//     security invariants in CLAUDE.md.

import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

export interface MakeS3ClientParams {
  /** Cloudflare account ID. Used to derive the R2 endpoint host. */
  accountId: string;
  /** Plaintext R2 access key. Decrypted in the route handler immediately
   *  before calling this factory; never persisted, never logged. */
  accessKeyId: string;
  /** Plaintext R2 secret access key. Same handling as accessKeyId. */
  secretAccessKey: string;
}

// Fail fast on missing/empty inputs so we never hand the SDK a malformed
// endpoint like `https://.r2.cloudflarestorage.com` (which would surface
// as an opaque DNS error several layers deep).
function requireNonEmpty(
  value: unknown,
  field: keyof MakeS3ClientParams,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`makeS3Client: ${field} must be a non-empty string`);
  }
}

/** Build a fresh S3Client pointed at the caller's R2 account. Returns a
 *  new instance every call — see file header for the no-caching rationale. */
export function makeS3Client(params: MakeS3ClientParams): S3Client {
  // Reading via optional chaining avoids a TypeError on undefined params
  // before we get to the explicit field-by-field check below.
  requireNonEmpty(params?.accountId, "accountId");
  requireNonEmpty(params?.accessKeyId, "accessKeyId");
  requireNonEmpty(params?.secretAccessKey, "secretAccessKey");

  return new S3Client({
    region: "auto",
    endpoint: `https://${params.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: params.accessKeyId,
      secretAccessKey: params.secretAccessKey,
    },
  });
}
