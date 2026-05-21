// lib/r2/errors.ts
//
// Concrete error classes + a single mapper that every R2/S3 wrapper in
// lib/r2/* routes upstream failures through. Two reasons it lives apart
// from lib/api/errors.ts:
//
//   1. lib/api/errors.ts is the wire-shape boundary (HTTP code + JSON);
//      this file is the *domain* boundary (which kind of R2 failure was
//      it?). Route handlers translate one to the other.
//   2. Credential-vs-upstream is the only distinction the rest of the
//      app needs: credential failures prompt re-entry (401), everything
//      else is treated as a transient upstream issue (5xx, possibly
//      retryable). Keeping this binary keeps the surface small.
//
// Hard rules enforced here:
//   - Never JSON.stringify the upstream error. AWS SDK error objects can
//     have circular refs in $metadata/$response and may carry internal
//     URLs in `message` — leaking either is a security/PII risk.
//   - Never forward the upstream `.message` verbatim as the wrapper
//     message. Use a fixed diagnostic string and stash the original on
//     `cause` for server-side logging only.
//   - Pass through existing R2CredentialError / R2UpstreamError instances
//     unchanged so wrappers can chain mapR2Error without double-wrapping
//     and losing the original code / httpStatus.

import "server-only";

/** Credentials are wrong, expired, or lack permission for the action.
 * Route layer should treat this as 401 and prompt the user to re-enter
 * their R2 keys. */
export class R2CredentialError extends Error {
  override readonly name = "R2CredentialError";
  constructor(message = "Invalid or unauthorized R2 credentials") {
    super(message);
  }
}

/** Any other R2 / S3 upstream failure — network, throttling, internal
 * error, malformed request, etc. `code` and `httpStatus` are preserved
 * for audit logging and retry decisions; `cause` (Error.cause) keeps the
 * original for server-side diagnostics but MUST NOT be serialized to the
 * client (may contain SDK internals, account-scoped URLs, request IDs). */
export class R2UpstreamError extends Error {
  override readonly name = "R2UpstreamError";
  readonly code?: string;
  readonly httpStatus?: number;
  constructor(
    message: string,
    opts: { code?: string; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

// AccessDenied / Unauthorized are included here because R2 returns them
// for valid-but-insufficient keys, and the UX for "wrong creds" vs
// "right creds, no perms" is the same: re-enter your access key pair.
const CREDENTIAL_ERROR_NAMES = new Set([
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "AccessDenied",
  "Unauthorized",
]);

interface SdkLikeError {
  name?: string;
  Code?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

/** Reads the upstream error code from whichever field the SDK chose to
 * populate. Order matters:
 *   - `.name`  → AWS SDK v3 modern path (most R2 calls land here)
 *   - `.Code`  → XML envelope / legacy SDK path
 *   - `.code`  → transport / system errors (ENOTFOUND, ECONNRESET, …) */
function readSdkErrorCode(err: SdkLikeError): string | undefined {
  return err.name ?? err.Code ?? err.code;
}

function readHttpStatus(err: SdkLikeError): number | undefined {
  return err.$metadata?.httpStatusCode;
}

/** Normalize ANY thrown value from an R2/S3 SDK call into one of our two
 * concrete classes. Returns (not throws) so callers can decide whether to
 * `throw mapR2Error(err)` for control flow or just inspect. */
export function mapR2Error(err: unknown): R2CredentialError | R2UpstreamError {
  if (err instanceof R2CredentialError || err instanceof R2UpstreamError) {
    return err;
  }
  if (err === null || typeof err !== "object") {
    return new R2UpstreamError("R2 upstream failure", { cause: err });
  }
  const sdk = err as SdkLikeError;
  const code = readSdkErrorCode(sdk);
  if (code !== undefined && CREDENTIAL_ERROR_NAMES.has(code)) {
    return new R2CredentialError();
  }
  return new R2UpstreamError("R2 upstream failure", {
    code,
    httpStatus: readHttpStatus(sdk),
    cause: err,
  });
}
