// lib/format/connections.ts
//
// Pure formatters for connection display. Lives in lib/ rather than next to
// the table component so it can be unit-tested without pulling in React +
// the component tree, AND so other surfaces (the switcher menu, future CLI
// dumps, audit log views) can format account IDs the same way.

/**
 * Compress a 32-hex-char R2 account ID to a glanceable form: first 4 +
 * ellipsis + last 4. The full ID is rarely useful in a table cell and
 * truncation prevents accidental shoulder-surfing screenshots from
 * leaking the full identifier.
 *
 *   "8b21a3f4c705e6d09b8214f6c7a9b3d2" → "8b21…b3d2"
 *   "short"                            → "short" (defensive passthrough)
 *
 * The threshold of 8 means a malformed short ID is shown verbatim rather
 * than getting clipped to a meaningless "abcd…abcd" — better to surface
 * "your account ID looks wrong" than to hide it behind ellipses.
 */
export function maskAccountId(accountId: string): string {
  if (accountId.length < 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}
