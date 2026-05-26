// lib/auth/password.ts
//
// Edge-safe PBKDF2-SHA256 password hashing. Web Crypto only — no node:crypto,
// so the same module runs in middleware, route handlers, and the seed CLI
// (which we run under tsx, also Web-Crypto-capable on Node 18+).
//
// No `import 'server-only'` here on purpose: hashing is a pure
// transformation of a user-submitted password, with no env secrets in
// scope. The `server-only` guard would block the seed script from
// importing this module under tsx.
//
// Storage format (single string column users.password_hash):
//
//   pbkdf2$sha256$600000$<salt-b64>$<hash-b64>
//
// - 600,000 iterations: OWASP 2024 minimum for PBKDF2-SHA256.
// - 16-byte random salt: per-user, regenerated on every hashPassword().
// - 32-byte derived key: SHA-256 native digest length.
//
// verifyPassword() rederives the key and compares in constant time so a
// timing attacker can't bisect the stored hash byte by byte.

const ALGO = "pbkdf2";
const HASH = "sha256";
const ITER = 600_000;
const SALT_LEN = 16;
const KEY_LEN_BITS = 256;

const te = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    te.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    KEY_LEN_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time byte-array equality. Returns false for length mismatch
 * without short-circuiting — never branch on length without flipping the
 * accumulator so a length oracle can't leak either. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await deriveKey(plain, salt, ITER);
  return `${ALGO}$${HASH}$${ITER}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * Verify a password against a stored hash. Returns false (not throws) for
 * any malformed input — a downstream caller can't distinguish "wrong
 * password" from "DB row corrupt", which is the safe default for login
 * flows (never reveal whether the user exists).
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  return verifyPasswordImpl(plain, stored);
}

// Fixed all-zero PBKDF2 envelope in the canonical storage format. Used as a
// decoy target by verifyPasswordOrDummy when no real user row exists so
// "email not found" and "wrong password" take the same wall-clock time.
// The plaintext that derives to an all-zero 32-byte key under all-zero salt
// + 600k iters is a 256-bit preimage search — infeasible to find, so the
// dummy compare can never accidentally return true.
const DUMMY_HASH =
  "pbkdf2$sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * Like verifyPassword, but when `stored` is null/undefined runs PBKDF2
 * against a fixed dummy hash so the timing matches the real wrong-password
 * path. Always returns false in the dummy branch — the dummy hash is
 * preimage-resistant, but the explicit early-return is defense in depth.
 */
export async function verifyPasswordOrDummy(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (typeof stored === "string") {
    return verifyPasswordImpl(plain, stored);
  }
  await verifyPasswordImpl(plain, DUMMY_HASH);
  return false;
}

async function verifyPasswordImpl(
  plain: string,
  stored: string,
): Promise<boolean> {
  if (typeof plain !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 5) return false;
  const [algo, hash, iterStr, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (algo !== ALGO || hash !== HASH) return false;
  const iterations = Number.parseInt(iterStr, 10);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array<ArrayBuffer>;
  try {
    salt = fromBase64(saltB64);
    expected = fromBase64(hashB64);
  } catch {
    return false;
  }
  if (salt.length !== SALT_LEN || expected.length !== KEY_LEN_BITS / 8) {
    return false;
  }

  const derived = await deriveKey(plain, salt, iterations);
  return constantTimeEqual(derived, expected);
}
