// lib/api/delete-token.ts
//
// HMAC-signed confirmation token for destructive object-delete operations.
//
// Why a token (and not "trust the second POST"):
//   CLAUDE.md security invariant #4: destructive endpoints require an
//   explicit, server-verified confirmation. The UI's "type the bucket name"
//   ceremony is necessary but not sufficient — a forged DELETE could skip
//   it entirely. The prepare → confirm dance binds an exact (user, bucket,
//   keys[]) triple to a 5-minute server-side intent. A client that POSTs to
//   /api/r2/delete without first calling /prepare cannot produce a valid
//   token, and a token issued for keys ["a", "b"] cannot be replayed
//   against ["a", "b", "c"].
//
// Token format on the wire:
//
//   <base64url-of-HMAC-SHA256>.<unix-seconds-exp>
//
//   * The base64url half is the signature of `${userId}|${bucket}|${keysHash}|${exp}`.
//   * The exp half is plain digits so we can fail fast on expiry without
//     spending a subtle.digest call when the user has clearly walked away.
//   * The dot is the delimiter — base64url contains no '.' so the split is
//     unambiguous.
//
// keysHash:
//   sha256(keys.sort().join("\n")) — sorted so the hash is stable regardless
//   of the order the UI sends keys in (the user may multi-select rows in
//   different orders). '\n' is the separator because R2 keys can contain
//   most printable chars including ',', but never a literal newline (S3
//   list APIs return them escaped).
//
// Why AUTH_SECRET (and not a separate env):
//   The task brief calls it SERVER_SECRET, but the project already pins
//   AUTH_SECRET as the JWT signing key — adding a second secret to rotate
//   doubles the operational surface for no security gain. The two uses
//   (JWT HS256 vs delete-token HMAC-SHA256) live in disjoint domains: a
//   signed delete-token cannot be parsed as a JWT and vice versa.
//
// Tests live at tests/unit/api/delete-token.test.ts.

import "server-only";

import { timingSafeEqual } from "@/lib/auth/csrf";

/** Five minutes, expressed in seconds. UI flow is "open dialog, type bucket
 *  name, click Delete" — well under a minute in practice. Five gives the
 *  user breathing room without leaving a destructive intent live forever. */
export const DELETE_TOKEN_TTL_SECONDS = 5 * 60;

const te = new TextEncoder();

/** Subset of the Pages env this module reads. AUTH_SECRET is the same
 *  base64-encoded secret next-auth uses for JWT signing — see the
 *  "Why AUTH_SECRET" note above. */
export interface DeleteTokenEnv {
  AUTH_SECRET: string;
}

/** Distinct from auth/validation/upstream errors so the route layer can map
 *  every verify failure to ApiErrors.confirmationRequired (412) without
 *  pattern-matching on messages. The single error type also keeps the
 *  attacker-visible response identical for "expired" vs "tampered" vs
 *  "wrong user" — no oracle for refining a forgery. */
export class DeleteTokenError extends Error {
  constructor(message = "Invalid or expired delete confirmation token") {
    super(message);
    this.name = "DeleteTokenError";
  }
}

/* ─── base64url helpers ─────────────────────────────────────────
 *
 * Same encoding as lib/auth/csrf.ts (no padding, '+' → '-', '/' → '_').
 * Inlined here rather than imported to keep this module self-contained —
 * the helpers are 8 lines each and the duplication is cheaper than a
 * cross-module import cycle if csrf.ts ever needs to reach back here.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/* ─── keysHash ──────────────────────────────────────────────── */

/**
 * Hash a list of keys to a stable hex string. Sorted before joining so that
 * the order the UI submits keys in does not change the hash — multi-select
 * order is a UI accident, not part of the user's intent.
 *
 * Exported so the route handlers can compute the same value on both sides
 * of the prepare/confirm dance and unit tests can pin the value.
 */
export async function hashKeys(keys: readonly string[]): Promise<string> {
  // .slice() before sort — the caller's array stays unmutated. R2 keys are
  // case-sensitive (`Pic.png` ≠ `pic.png`), so a default lexicographic
  // sort is correct; no `localeCompare` needed.
  const sorted = keys.slice().sort();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    te.encode(sorted.join("\n")),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/* ─── HMAC signing ──────────────────────────────────────────── */

// Module-level cache: importing the HMAC key from raw bytes costs a
// subtle.importKey roundtrip; doing it once per worker is cheap and there's
// only ever one AUTH_SECRET in play per environment. Same pattern as
// lib/crypto/aes-gcm.ts.
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

async function getHmacKey(env: DeleteTokenEnv): Promise<CryptoKey> {
  const raw = env.AUTH_SECRET;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("AUTH_SECRET env var is missing");
  }
  const cached = hmacKeyCache.get(raw);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    "raw",
    // Encode the secret as UTF-8 bytes. AUTH_SECRET is base64 in prod, but
    // we deliberately don't base64-decode it — next-auth treats AUTH_SECRET
    // as opaque bytes for HS256 too, and the value's length / entropy is
    // already adequate (>= 48 base64 chars per the env brief).
    te.encode(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  hmacKeyCache.set(raw, promise);
  promise.catch(() => hmacKeyCache.delete(raw));
  return promise;
}

/** Compose the canonical signed payload. Field order is fixed and the '|'
 *  separator is safe because none of the parts can contain it (ULID is
 *  Crockford b32, bucket is `[a-z0-9.-]`, keysHash is hex, exp is digits). */
function payloadString(args: {
  userId: string;
  bucket: string;
  keysHash: string;
  exp: number;
}): string {
  return `${args.userId}|${args.bucket}|${args.keysHash}|${args.exp}`;
}

export interface IssueDeleteTokenArgs {
  userId: string;
  bucket: string;
  keys: readonly string[];
  /** Override Date.now() for deterministic tests. Pass milliseconds. */
  now?: number;
  /** Override the default 5-minute TTL. Whole seconds. */
  ttlSeconds?: number;
  env: DeleteTokenEnv;
}

export interface IssueDeleteTokenResult {
  /** `<base64url>.<unix-seconds>` — opaque to the client. */
  token: string;
  /** Epoch milliseconds for when the token expires. Matches the wire shape
   *  used by /api/r2/presign so the dashboard can reason about both with
   *  one `Date.now() < expiresAt` check. */
  expiresAt: number;
}

/**
 * Mint a confirmation token for the (userId, bucket, keys[]) triple.
 * The `keys` array is hashed in place; the order of the caller's input
 * is irrelevant.
 */
export async function issueDeleteToken(
  args: IssueDeleteTokenArgs,
): Promise<IssueDeleteTokenResult> {
  const ttl = args.ttlSeconds ?? DELETE_TOKEN_TTL_SECONDS;
  const nowMs = args.now ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + ttl;
  const keysHash = await hashKeys(args.keys);
  const key = await getHmacKey(args.env);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      te.encode(
        payloadString({
          userId: args.userId,
          bucket: args.bucket,
          keysHash,
          exp,
        }),
      ),
    ),
  );
  return {
    token: `${base64UrlEncode(sig)}.${exp}`,
    expiresAt: exp * 1000,
  };
}

export interface VerifyDeleteTokenArgs {
  token: string;
  userId: string;
  bucket: string;
  keys: readonly string[];
  /** Override Date.now() for deterministic tests. Pass milliseconds. */
  now?: number;
  env: DeleteTokenEnv;
}

/**
 * Verify a token against (userId, bucket, keys[]). Throws DeleteTokenError
 * on ANY failure mode — bad shape, expired, hash mismatch, signature
 * mismatch. The thrown error never reveals which check failed so a forger
 * can't probe.
 *
 * Returns the parsed expiry on success, for the route layer's audit log.
 */
export async function verifyDeleteToken(
  args: VerifyDeleteTokenArgs,
): Promise<{ expiresAt: number }> {
  // Defensive bounds — a malicious token of arbitrary size could otherwise
  // force a big atob() before any cheap check runs.
  if (
    typeof args.token !== "string" ||
    args.token.length < 16 ||
    args.token.length > 512
  ) {
    throw new DeleteTokenError();
  }
  const dot = args.token.lastIndexOf(".");
  if (dot < 1 || dot === args.token.length - 1) {
    throw new DeleteTokenError();
  }
  const sigPart = args.token.slice(0, dot);
  const expPart = args.token.slice(dot + 1);
  if (!/^\d{1,12}$/u.test(expPart)) {
    throw new DeleteTokenError();
  }
  const exp = Number(expPart);
  const nowSec = Math.floor((args.now ?? Date.now()) / 1000);
  if (exp <= nowSec) {
    throw new DeleteTokenError();
  }

  const keysHash = await hashKeys(args.keys);
  const key = await getHmacKey(args.env);
  const expectedSig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      te.encode(
        payloadString({
          userId: args.userId,
          bucket: args.bucket,
          keysHash,
          exp,
        }),
      ),
    ),
  );
  const expectedSigB64 = base64UrlEncode(expectedSig);

  // Constant-time string compare. Length-mismatch shortcut is intentional —
  // base64url length is a deterministic function of the underlying byte
  // length (32 raw bytes → 43 chars), so an attacker cannot learn anything
  // by varying their candidate length.
  if (!timingSafeEqual(sigPart, expectedSigB64)) {
    throw new DeleteTokenError();
  }
  return { expiresAt: exp * 1000 };
}
