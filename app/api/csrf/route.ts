// app/api/csrf/route.ts
//
// CSRF cookie bootstrap. The client calls GET /api/csrf once per session
// (or whenever the cookie is missing) and receives:
//
//   1. A non-httpOnly `csrf` cookie carrying the raw token.
//   2. The same token in the JSON body, so SPAs can stash it in memory
//      without re-reading the cookie.
//
// This endpoint is GET-only and therefore CSRF-exempt — that's deliberate.
// The endpoint's job is to *seed* the CSRF cookie, not to mutate state, so
// requiring a CSRF header here would create a chicken/egg problem.

import { requireSession } from "@/lib/api/middleware";
import { toErrorResponse } from "@/lib/api/errors";
import { buildCsrfCookie, CSRF_COOKIE_NAME } from "@/lib/auth/csrf";


const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function GET(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const session = await requireSession(req);
    if (!session.csrfToken) {
      // Session row exists (requireSession passed D1 lookup) but the JWT
      // didn't carry a csrfToken — this can only happen for a session that
      // pre-dates the CSRF feature. Force a re-login.
      return toErrorResponse(
        new Error("legacy session without csrf binding"),
        requestId,
      );
    }
    const headers = new Headers({
      "content-type": "application/json",
      "x-request-id": requestId,
      // Setting the cookie is the whole point — same value the client will
      // echo back in X-CSRF-Token on the next mutating request.
      "set-cookie": buildCsrfCookie(session.csrfToken, {
        maxAgeSeconds: SEVEN_DAYS,
      }),
      // Cache-control: never cache; the cookie / token rotates per session.
      "cache-control": "no-store",
    });
    return new Response(
      JSON.stringify({
        csrfToken: session.csrfToken,
        cookieName: CSRF_COOKIE_NAME,
      }),
      { status: 200, headers },
    );
  } catch (err) {
    return toErrorResponse(err, requestId);
  }
}
