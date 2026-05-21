// lib/auth/csrf-constants.ts
//
// CSRF protocol constants — cookie name + header name — split out from
// lib/auth/csrf.ts so they're safe to import from the browser. The main
// csrf.ts module declares `import "server-only"` because its hashing /
// random-token primitives must never run client-side; centralizing the
// shared names here lets `lib/api/client.ts` reference them without
// crossing that boundary.
//
// Do NOT add anything other than primitive string constants here. The
// moment a function lives in this file is the moment it can be called
// from a Client Component, which is exactly the wrong direction.

/** Cookie name carrying the raw CSRF token to the browser. Non-httpOnly so
 * JS can copy it into the X-CSRF-Token header. */
export const CSRF_COOKIE_NAME = "csrf";

/** Header the client MUST send on POST/PATCH/PUT/DELETE. */
export const CSRF_HEADER_NAME = "x-csrf-token";
