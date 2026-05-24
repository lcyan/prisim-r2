// lib/db/blob.ts
//
// Normalize a D1 blob column to Uint8Array. Drizzle's `blob({ mode: "buffer" })`
// returns three different concrete types depending on where the query ran:
//
//   * In production (Pages edge runtime), D1 returns ArrayBuffer.
//   * In `pnpm preview` / local Wrangler (D1 over miniflare), also ArrayBuffer.
//   * In vitest under jsdom, better-sqlite3 returns a Node Buffer — and
//     JSDOM's separate JS realm makes `instanceof Uint8Array` return false
//     even though Node's Buffer is a Uint8Array subclass in *Node's* realm.
//
// `Buffer.isBuffer` checks an internal slot, so it crosses realms reliably.
// The Buffer branch is gated on `typeof Buffer !== "undefined"` so it
// compiles down to dead code in the edge bundle (no `Buffer` global there).
//
// Web Crypto (`crypto.subtle`) needs a real Uint8Array — passing a Node
// Buffer directly works in Node but throws under WebCrypto's stricter
// type check on edge, so we always normalize before handing the bytes off.
//
// Per CLAUDE.md, lifted here so the 12 R2/share/dashboard routes don't
// each copy this function and drift. Callers pass their own context tag
// (e.g. "buckets", "presign") so the error message points at the route
// that hit it.

import "server-only";

export function asU8(value: unknown, context: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  throw new TypeError(
    `${context}: stored credential blob is neither Uint8Array nor ArrayBuffer`,
  );
}
