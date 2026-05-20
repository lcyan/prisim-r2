// lib/auth/csrf.ts
//
// CSRF protection primitives. Strategy: double-submit with server-stored
// hash binding.
//
//   1. At sign-in, the server generates a 32-byte random token, stores
//      sha256(token) in sessions.csrf_token_hash, and embeds the raw token
//      in the JWT.
//   2. /api/csrf reads the raw token from the JWT and emits it as a
//      non-httpOnly cookie + JSON. The client copies the cookie value into
//      the X-CSRF-Token header on every mutating request.
//   3. lib/api/middleware.ts compares sha256(header) against the D1 hash —
//      a tamper in any layer (cookie, header, JWT, DB) breaks the check.
//
// Why the hash in D1 even though the raw token is in the JWT: revoking a
// session (delete D1 row) MUST also revoke its CSRF authority. Tying the
// hash to sessions.id means a deleted session = no valid CSRF, even if a
// stolen JWT cookie is replayed before the JWT's own exp.
//
// This module is intentionally tiny + dependency-free so it can run on the
// Pages edge runtime (Web Crypto only — no node:crypto).

import "server-only";

/** Cookie name carrying the raw CSRF token to the browser. Non-httpOnly so
 * JS can copy it into the X-CSRF-Token header. */
export const CSRF_COOKIE_NAME = "csrf";
/** Header the client MUST send on POST/PATCH/PUT/DELETE. */
export const CSRF_HEADER_NAME = "x-csrf-token";

const te = new TextEncoder();

/** URL-safe base64 (RFC 4648 §5) without padding — safe for cookies + headers. */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a fresh random CSRF token. 32 bytes ≈ 128 bits of entropy after b64;
 * matches the brief and is comfortably resistant to brute-force.
 */
export function generateCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

/** sha256 hex of the raw CSRF token. Stored in sessions.csrf_token_hash. */
export async function hashCsrfToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(token));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Constant-time string compare. Both inputs MUST already be the same length
 * (we early-return false otherwise — leaking length is not exploitable for
 * 64-char hex hashes drawn from a uniform distribution, but it's free to be
 * cautious).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build a `Set-Cookie` header value for the CSRF cookie. SameSite=Lax keeps
 * the cookie on top-level navigations (so the user lands on /dashboard with
 * a usable token) while still defending against cross-origin POSTs.
 *
 * `secure` defaults to true in production; tests pass `false`.
 */
export function buildCsrfCookie(
  token: string,
  opts: { maxAgeSeconds: number; secure?: boolean } = { maxAgeSeconds: 60 * 60 * 24 * 7 },
): string {
  const secure = opts.secure ?? process.env.NODE_ENV === "production";
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${opts.maxAgeSeconds}`,
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  // Intentionally NOT HttpOnly — client JS must read this value.
  return parts.join("; ");
}
