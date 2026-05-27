// lib/api/errors.ts
//
// Unified API error model. Every error response across /api/* MUST go through
// `toErrorResponse(err, requestId)` so the wire shape is:
//
//   { error: { code, message, requestId, details? } }
//
// `code` is one of the stable strings in `ApiErrorCode`. Clients pattern-match
// on `code`, never on `message` (which is human-only and may change).
// `requestId` is generated per request in lib/api/middleware.ts and shows up
// in audit logs — the user can quote it when reporting issues.
//
// Subclassing Error keeps stack traces useful in dev; we never serialize the
// stack to the client (would leak server paths).

import { ZodError } from "zod";

/** Canonical machine-readable error codes. Add new ones here — never inline
 * a raw string at a callsite. Grouped by `<domain>.<reason>` so a switch in
 * the client can route by prefix. */
export const ApiErrorCode = {
  AuthUnauthorized: "auth.unauthorized",
  AuthForbidden: "auth.forbidden",
  CsrfInvalid: "csrf.invalid",
  ValidationInvalid: "validation.invalid",
  NotFound: "resource.not_found",
  Conflict: "resource.conflict",
  ConfirmationRequired: "confirmation.required",
  RateLimited: "rate_limited",
  // Domain-specific: the user-supplied R2 keys were rejected upstream during
  // a connection-create probe (listBuckets). Distinct from auth.unauthorized
  // (which is OUR session) so the client can surface "wrong R2 keys, retry"
  // rather than logging the user out.
  ConnectionInvalidCredentials: "connection.invalid_credentials",
  // Domain-specific: blocked because deleting the resource would orphan
  // related rows (e.g. DELETE /connections/[id] with active shares).
  ConnectionInUse: "connection.in_use",
  // TOTP 二次验证流程
  TotpEnrollmentRequired: "auth.totp.enrollment_required",
  TotpInvalidCode: "auth.totp.invalid_code",
  TotpReplay: "auth.totp.replay",
  TotpGrantExpired: "auth.totp.grant_expired",
  TotpAlreadyEnrolled: "auth.totp.already_enrolled",
  RecoveryCodeInvalid: "auth.recovery_code.invalid",
  // 凭据错(密码错或用户不存在,统一文案防 enumeration)。前端展示同
  // CredentialsSignin 的现行 "auth.invalid_credentials" key。
  InvalidCredentials: "auth.invalid_credentials",
  // R2 folder creation
  R2FolderInvalidName: "r2.folder_invalid_name",
  R2FolderTooDeep: "r2.folder_too_deep",
  InternalUnexpected: "internal.unexpected",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Thrown anywhere in a withApi-wrapped handler. `withApi` catches it and
 * formats the response. `details` is opaque JSON — used by validation errors
 * to ship a flattened Zod issue map. Never put secrets in here.
 *
 * `headers` lets specific error types attach extra Response headers (e.g.
 * `Retry-After` for 429) without forcing toErrorResponse to special-case
 * each code. */
export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Factory helpers — prefer over `new ApiError(...)` so the status + code
 * pairing stays consistent across the codebase. */
export const ApiErrors = {
  unauthorized: (message = "Not authenticated") =>
    new ApiError(ApiErrorCode.AuthUnauthorized, message, 401),
  forbidden: (message = "Forbidden") =>
    new ApiError(ApiErrorCode.AuthForbidden, message, 403),
  csrfInvalid: (message = "Invalid CSRF token") =>
    new ApiError(ApiErrorCode.CsrfInvalid, message, 401),
  validationInvalid: (zerr: ZodError) =>
    new ApiError(
      ApiErrorCode.ValidationInvalid,
      "Invalid request payload",
      400,
      zerr.flatten(),
    ),
  notFound: (message = "Resource not found") =>
    new ApiError(ApiErrorCode.NotFound, message, 404),
  conflict: (message = "Conflict") =>
    new ApiError(ApiErrorCode.Conflict, message, 409),
  confirmationRequired: (message = "Confirmation token required") =>
    new ApiError(ApiErrorCode.ConfirmationRequired, message, 412),
  rateLimited: (message = "Too many requests") =>
    new ApiError(ApiErrorCode.RateLimited, message, 429),
  /** 429 with a Retry-After header. `retryAfterSeconds` MUST be a positive
   *  integer (checkLimit already clamps it). The `code` override lets the
   *  client distinguish, e.g., login vs. presign limits via the existing
   *  rate_limited code suffixed in `details.policy`. */
  rateLimitedWithRetry: (
    retryAfterSeconds: number,
    details?: unknown,
    message = "Too many requests",
  ) =>
    new ApiError(ApiErrorCode.RateLimited, message, 429, details, {
      "Retry-After": String(retryAfterSeconds),
    }),
  /** R2 rejected the user-supplied access/secret pair during the
   *  create-connection probe. 400 (not 401) — OUR session is fine. */
  connectionInvalidCredentials: (
    message = "R2 credentials were rejected by Cloudflare",
  ) => new ApiError(ApiErrorCode.ConnectionInvalidCredentials, message, 400),
  /** Deleting the resource would orphan related rows; 409 matches REST
   *  convention for "resource conflict prevents action". */
  connectionInUse: (
    details?: unknown,
    message = "Connection has active shares; remove them first",
  ) => new ApiError(ApiErrorCode.ConnectionInUse, message, 409, details),
  r2FolderInvalidName: (reason: string) =>
    new ApiError(
      ApiErrorCode.R2FolderInvalidName,
      `Invalid folder name: ${reason}`,
      400,
    ),
  r2FolderTooDeep: () =>
    new ApiError(
      ApiErrorCode.R2FolderTooDeep,
      "Folder path exceeds R2 key length limit (1024 bytes)",
      400,
    ),
  totpEnrollmentRequired: (message = "需要先绑定 TOTP") =>
    new ApiError(ApiErrorCode.TotpEnrollmentRequired, message, 401),
  totpInvalidCode: (message = "验证码错误或已过期") =>
    new ApiError(ApiErrorCode.TotpInvalidCode, message, 400),
  totpReplay: (message = "验证码已使用") =>
    new ApiError(ApiErrorCode.TotpReplay, message, 400),
  totpGrantExpired: (message = "绑定流程已超时") =>
    new ApiError(ApiErrorCode.TotpGrantExpired, message, 410),
  totpAlreadyEnrolled: (message = "已绑定 TOTP") =>
    new ApiError(ApiErrorCode.TotpAlreadyEnrolled, message, 409),
  recoveryCodeInvalid: (message = "恢复码无效或已使用") =>
    new ApiError(ApiErrorCode.RecoveryCodeInvalid, message, 401),
  invalidCredentials: (message = "邮箱或密码错误") =>
    new ApiError(ApiErrorCode.InvalidCredentials, message, 401),
  internal: (message = "Unexpected server error") =>
    new ApiError(ApiErrorCode.InternalUnexpected, message, 500),
};

export interface ApiErrorPayload {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

const REQUEST_ID_HEADER = "x-request-id";

/** Build a Response for any thrown value. Known ApiError + ZodError carry
 * structured info; everything else collapses to a generic 500 so we never
 * leak an internal Error.message to the client. */
export function toErrorResponse(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return Response.json(
      {
        error: {
          code: err.code,
          message: err.message,
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      } satisfies ApiErrorPayload,
      {
        status: err.status,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          ...(err.headers ?? {}),
        },
      },
    );
  }
  if (err instanceof ZodError) {
    return toErrorResponse(ApiErrors.validationInvalid(err), requestId);
  }
  return Response.json(
    {
      error: {
        code: ApiErrorCode.InternalUnexpected,
        message: "Unexpected server error",
        requestId,
      },
    } satisfies ApiErrorPayload,
    { status: 500, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
