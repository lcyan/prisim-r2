// lib/auth/totp.ts
//
// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s period) on Web Crypto. No
// `import "server-only"` — pure transforms, no env reads, safe to import
// from edge route + unit test.

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALGORITHM = "SHA-1";

/** RFC 4648 §6 — base32 (no padding). */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function normalizeTotpCandidate(candidate: string): string {
  return candidate.replace(/\s/g, "");
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += B32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32[(value << (5 - bits)) & 0x1f];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/, "");
  for (const ch of cleaned) {
    if (B32.indexOf(ch) === -1) throw new Error("invalid base32 character");
  }
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 20-byte random secret (>= 160 bit per RFC 6238 §5.1 recommendation). */
export function generateTotpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(20));
}

async function hmacSha1(
  keyBytes: Uint8Array,
  msg: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: ALGORITHM },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, msg as BufferSource);
  return new Uint8Array(sig);
}

function uint64BE(n: number): Uint8Array {
  // JS bitwise ops on 53-bit Numbers are safe for unix-step values until
  // year ~9999, so plain math is fine here. Output big-endian.
  const buf = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

/**
 * Generate the 6-digit code for `secret` at unix time `unixSeconds`. Uses
 * the standard HOTP dynamic truncation per RFC 4226 §5.3.
 */
export async function generateTotpCode(
  secret: Uint8Array,
  unixSeconds: number,
): Promise<string> {
  const step = Math.floor(unixSeconds / STEP_SECONDS);
  const hash = await hmacSha1(secret, uint64BE(step));
  const offset = hash[hash.length - 1]! & 0x0f;
  const code =
    (((hash[offset]! & 0x7f) << 24) |
      ((hash[offset + 1]! & 0xff) << 16) |
      ((hash[offset + 2]! & 0xff) << 8) |
      (hash[offset + 3]! & 0xff)) %
    10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

export interface VerifyResult {
  ok: boolean;
  /** Matched HOTP step (unixSeconds / 30) on success; undefined on miss. */
  matchedStep?: number;
}

/**
 * Verify `candidate` against `secret` allowing ±1 step (30s) clock drift.
 * `nowUnixSeconds` defaults to current wall-clock; tests inject deterministic
 * values. Returns the matched step so callers can update the replay guard.
 *
 * Time-leakage note: we use a constant-time compare per candidate so a
 * timing oracle can't deduce which step matched.
 */
export async function verifyTotpCode(
  secret: Uint8Array,
  candidate: string,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const normalized = normalizeTotpCandidate(candidate);
  if (!/^\d{6}$/.test(normalized)) return { ok: false };
  let matched: number | undefined;
  let anyMatch = 0;
  for (const delta of [-1, 0, 1]) {
    const t = nowUnixSeconds + delta * STEP_SECONDS;
    const expected = await generateTotpCode(secret, t);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) {
      diff |= expected.charCodeAt(i) ^ normalized.charCodeAt(i);
    }
    if (diff === 0) {
      anyMatch = 1;
      matched = Math.floor(t / STEP_SECONDS);
    }
  }
  return anyMatch ? { ok: true, matchedStep: matched! } : { ok: false };
}

export interface BuildOtpauthUriInput {
  issuer: string;
  label: string; // typically the user's email
  secret: Uint8Array;
}

/** Standard Google Authenticator otpauth URI. The label is `issuer:label`. */
export function buildOtpauthUri(input: BuildOtpauthUriInput): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = encodeURIComponent(input.label);
  const secret = base32Encode(input.secret);
  // Build query manually: URLSearchParams encodes spaces as `+`, but the
  // otpauth spec / authenticator apps expect `%20` (RFC 3986 percent-encoding).
  const params = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    `algorithm=SHA1`,
    `digits=${DIGITS}`,
    `period=${STEP_SECONDS}`,
  ].join("&");
  return `otpauth://totp/${issuer}:${label}?${params}`;
}
