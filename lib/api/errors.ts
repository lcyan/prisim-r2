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
  InternalUnexpected: "internal.unexpected",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Thrown anywhere in a withApi-wrapped handler. `withApi` catches it and
 * formats the response. `details` is opaque JSON — used by validation errors
 * to ship a flattened Zod issue map. Never put secrets in here. */
export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
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
      { status: err.status, headers: { [REQUEST_ID_HEADER]: requestId } },
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
