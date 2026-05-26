// lib/auth/recovery-codes.ts
//
// Recovery codes for TOTP fallback. 10 codes per user, base32 alphabet, 4
// chars + hyphen + 4 chars = 8 alphanum + separator. Stored as
// HMAC-SHA256(key=users.id, msg=normalized-code) hex — the per-user key
// means a DB dump cannot be cross-correlated across users (same plaintext
// code generates different hashes for different users). One-shot consume.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const RECOVERY_CODE_COUNT = 10;
const HALF_LEN = 4;

const te = new TextEncoder();

function randomBlock(len: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return out;
}

/** Generate 10 unique recovery codes formatted as "XXXX-YYYY". */
export function generateRecoveryCodes(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  while (out.length < RECOVERY_CODE_COUNT) {
    const code = `${randomBlock(HALF_LEN)}-${randomBlock(HALF_LEN)}`;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Accept user input in flexible forms ("abcd-2345", "abcd2345", "ABCD 2345")
 * and canonicalize to "ABCD-2345". Returns null when the shape doesn't fit
 * so the caller can short-circuit without a DB lookup.
 */
export function normalizeRecoveryCode(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s/g, "").replace(/-/g, "").toUpperCase();
  if (cleaned.length !== HALF_LEN * 2) return null;
  for (const ch of cleaned) {
    if (ALPHABET.indexOf(ch) === -1) return null;
  }
  return `${cleaned.slice(0, HALF_LEN)}-${cleaned.slice(HALF_LEN)}`;
}

/**
 * HMAC-SHA256 hex of the *normalized* code, keyed by the user's ULID. The
 * per-user key blocks cross-user collision searches in case of a DB dump:
 * two users that happen to roll the same plaintext code get different
 * hashes, so an attacker who knows one user's plaintext cannot search the
 * dump for matching hashes elsewhere.
 *
 * Unknown shapes fall through to the uppercased raw input so callers see a
 * deterministic non-match without an extra branch — the resulting hash will
 * never collide with a real code because real codes always normalize first.
 */
export async function hashRecoveryCode(
  raw: string,
  userId: string,
): Promise<string> {
  const normalized = normalizeRecoveryCode(raw);
  const input = normalized ?? raw.toUpperCase();
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(userId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, te.encode(input));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
