// lib/api/middleware.ts
//
// Composable request middleware for /api/* route handlers. Pipeline:
//
//   withApi(handler, options?) → assigns requestId
//                              → requireSession   (D1 revocation check)
//                              → requireCsrf      (POST/PATCH/PUT/DELETE only)
//                              → rateLimit        (opt-in, after CSRF)
//                              → handler(req, ctx)
//                              → try/catch → toErrorResponse
//
// Every wrapped handler gets a typed `ctx` containing userId, sessionToken,
// and the requestId — handlers should pass requestId through to any audit
// log calls so the per-request trail stays correlated.
//
// Why a wrapper instead of a Next.js middleware? Next middleware runs in
// the Edge runtime WITHOUT request context, so we can't reach D1 there
// (this also forces rate limiting into the per-route layer — see the
// rateLimit option below). Per-route wrapping keeps the auth/CSRF check
// inline with the handler and gives us a typed context to pass downstream.

import "server-only";

import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { ZodError } from "zod";

import { getRequestContext } from "@cloudflare/next-on-pages";
import { createD1Adapter } from "@/lib/auth/adapter";
import { CSRF_HEADER_NAME, hashCsrfToken, timingSafeEqual } from "@/lib/auth/csrf";
import { getDb, type DbEnv } from "@/lib/db/client";

import { ApiErrors, toErrorResponse } from "./errors";
import { checkLimit, type RateLimitPolicy } from "./rate-limit";

/** Methods that mutate state — all require a valid X-CSRF-Token header.
 * GET/HEAD/OPTIONS are read-only and CSRF-exempt (browser doesn't preflight
 * simple GETs, so a stolen GET endpoint isn't a CSRF risk). */
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface SessionContext {
  userId: string;
  email: string;
  sessionToken: string;
  /** Raw CSRF token from the JWT — handlers don't usually need this, but
   * /api/csrf reads it to populate the response cookie. */
  csrfToken: string;
  /** sha256 hex of the CSRF token, as stored in D1. */
  csrfTokenHash: string | null;
}

export interface ApiRequestContext extends SessionContext {
  requestId: string;
}

interface AuthEnv extends DbEnv {
  AUTH_SECRET?: string;
}

function getEnv(): AuthEnv {
  return getRequestContext().env as unknown as AuthEnv;
}

/**
 * Resolve the current session or throw 401. Performs the D1 revocation
 * check (deleted session row → reject) inline so route handlers don't need
 * a separate auth() call.
 */
export async function requireSession(req: Request): Promise<SessionContext> {
  const env = getEnv();
  const secret = env.AUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    // Configuration error, not an auth failure — surface as 500.
    throw new Error("AUTH_SECRET is not configured");
  }

  // next-auth's getToken accepts the Web Request directly in v5; we pass
  // through `NextRequest` to satisfy the .ts overload signature.
  const token = await getToken({
    req: req as unknown as NextRequest,
    secret,
    // Match next-auth v5's cookie naming. Auth.js auto-prefixes __Secure-
    // when the request is HTTPS, so leaving these undefined lets it pick.
  });

  if (
    !token ||
    typeof token.userId !== "string" ||
    typeof token.sessionToken !== "string"
  ) {
    throw ApiErrors.unauthorized();
  }

  const adapter = createD1Adapter(getDb(env));
  const record = await adapter.getSessionAndUser(token.sessionToken);
  if (!record) throw ApiErrors.unauthorized("Session revoked");

  return {
    userId: record.user.id,
    email: record.user.email,
    sessionToken: token.sessionToken,
    csrfToken: typeof token.csrfToken === "string" ? token.csrfToken : "",
    csrfTokenHash: record.csrfTokenHash,
  };
}

/**
 * Verify the inbound X-CSRF-Token header against the session-bound hash in
 * D1. Both sides MUST be present — a session row that pre-dates the CSRF
 * column (csrfTokenHash === null) cannot mutate state until the user signs
 * in again (which will populate it).
 */
export async function requireCsrf(
  req: Request,
  session: Pick<SessionContext, "csrfTokenHash">,
): Promise<void> {
  const header = req.headers.get(CSRF_HEADER_NAME);
  if (!header || header.length < 16 || header.length > 256) {
    throw ApiErrors.csrfInvalid();
  }
  if (!session.csrfTokenHash) {
    throw ApiErrors.csrfInvalid("Session has no CSRF binding; sign in again");
  }
  const incomingHash = await hashCsrfToken(header);
  if (!timingSafeEqual(incomingHash, session.csrfTokenHash)) {
    throw ApiErrors.csrfInvalid();
  }
}

export type ApiHandlerResult<T> = T | Response;

export type ApiHandler<T = unknown> = (
  req: Request,
  ctx: ApiRequestContext,
) => Promise<ApiHandlerResult<T>>;

/**
 * Resolves the rate-limit policies to enforce for one request. Receives the
 * authenticated context so the policy can key off `ctx.userId`. Return an
 * empty array to skip rate limiting for that request (e.g. an admin user
 * exempt from a particular bucket).
 */
export type RateLimitResolver = (args: {
  req: Request;
  ctx: ApiRequestContext;
}) => RateLimitPolicy[] | Promise<RateLimitPolicy[]>;

export interface WithApiOptions {
  /** Apply one or more sliding-window limits *after* session+CSRF have
   *  passed but *before* the handler runs. The first policy to exceed its
   *  limit wins — checkLimit calls earlier in the list still consumed a
   *  slot in their bucket. Order policies from most-specific to least-
   *  specific so the response's `details.policy` matches the user's intent
   *  (e.g. `presignByUser` before `writeAggregateByUser`). */
  rateLimit?: RateLimitResolver;
}

/**
 * Wrap a route handler with the session + CSRF + rate-limit + error-mapping
 * pipeline.
 *
 * Usage in a route file:
 *
 *   export const runtime = "edge";
 *   export const POST = withApi(
 *     async (req, ctx) => {
 *       const input = await parseJson(req, ConnectionsCreateSchema);
 *       // ...
 *       return { ok: true };
 *     },
 *     {
 *       rateLimit: ({ ctx }) => [
 *         RateLimitPolicies.presignByUser(ctx.userId),
 *         RateLimitPolicies.writeAggregateByUser(ctx.userId),
 *       ],
 *     },
 *   );
 *
 * Handlers may return either:
 *   - any JSON-serializable value (auto-wrapped in `Response.json` with 200)
 *   - a fully-formed Response (e.g. 201 with custom headers)
 *
 * Throwing `ApiError` or `ZodError` produces a normalized error response;
 * any other throw collapses to a 500 with code `internal.unexpected`.
 */
export function withApi<T = unknown>(
  handler: ApiHandler<T>,
  options: WithApiOptions = {},
) {
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    try {
      const session = await requireSession(req);
      if (MUTATING_METHODS.has(req.method.toUpperCase())) {
        await requireCsrf(req, session);
      }
      const ctx: ApiRequestContext = { ...session, requestId };

      if (options.rateLimit) {
        // CSRF first, rate-limit second: requests with a forged/missing
        // CSRF header are rejected before they can consume bucket quota,
        // so attackers can't flood the bucket with rejected POSTs to
        // starve legitimate users.
        const policies = await options.rateLimit({ req, ctx });
        const env = getEnv();
        for (const policy of policies) {
          const result = await checkLimit({
            db: env.DB,
            key: policy.key,
            limit: policy.limit,
            windowMs: policy.windowMs,
          });
          if (!result.ok) {
            throw ApiErrors.rateLimitedWithRetry(
              result.retryAfter ?? 1,
              { policy: policy.key },
            );
          }
        }
      }

      const result = await handler(req, ctx);
      if (result instanceof Response) {
        // Tag responses that didn't already carry a request id, so clients
        // and reverse proxies see a consistent header.
        if (!result.headers.has("x-request-id")) {
          result.headers.set("x-request-id", requestId);
        }
        return result;
      }
      return Response.json(result ?? null, {
        status: 200,
        headers: { "x-request-id": requestId },
      });
    } catch (err) {
      // Log just enough to correlate the user-visible requestId with server
      // logs — never log the err.stack to telemetry that's user-visible.
      if (!(err instanceof ZodError)) {
        console.error(`[api ${requestId}] ${req.method} ${req.url}`, err);
      }
      return toErrorResponse(err, requestId);
    }
  };
}
