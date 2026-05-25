// lib/api/client-ip.ts
//
// Shared client-IP extraction for audit logging (lib/audit/log.ts) and rate
// limiting (lib/api/rate-limit.ts). Both callers walk the same
// `cf-connecting-ip` → `x-forwarded-for[0]` ladder; centralizing keeps any
// future header-policy change (e.g. trusting `Forwarded:`) a one-line edit.
//
//   * IP: prefer `cf-connecting-ip` (the only header Cloudflare's edge trusts
//     on Pages). Fall back to the first entry in `x-forwarded-for` for local
//     dev / preview behind a reverse proxy.
//   * Returns null on miss — the rate limiter wraps this with an "unknown"
//     sentinel; the audit table prefers NULL so SQL filters on `IS NULL`
//     don't collide with a real value the day someone sets `cf-connecting-ip: unknown`.

import "server-only";

export function parseClientIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}
