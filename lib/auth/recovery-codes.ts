// lib/auth/recovery-codes.ts
//
// Recovery codes for TOTP fallback. 10 codes per user, base32 alphabet, 4
// chars + hyphen + 4 chars = 8 alphanum + separator. sha256 hashed before
// storage (column recovery_codes.code_hash). One-shot consume.

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

/** sha256 hex of the *normalized* code. Constant across input variants. */
export async function hashRecoveryCode(raw: string): Promise<string> {
  const normalized = normalizeRecoveryCode(raw);
  // For unknown shapes still hash *something* so the caller sees a non-match
  // and the timing path is identical for invalid + non-match.
  const input = normalized ?? raw.toUpperCase();
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
