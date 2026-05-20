// lib/crypto/aes-gcm.ts
//
// AES-GCM-256 envelope for R2 access keys + secrets. All credential I/O
// MUST go through encryptCredential / decryptCredential — never persist
// plaintext to D1, logs, telemetry, or error messages.
//
// Why Web Crypto and not node:crypto: this module runs on the Pages edge
// runtime, where `crypto.subtle` is the only available primitive. Web Crypto
// also works under Vitest in Node 18+, so the same code is testable locally.
//
// Layout per call:
//   plaintext (utf-8) ─AES-GCM-256──> ciphertext  (returned)
//                       │                ▲
//                       ├── random IV (12 bytes, returned alongside ciphertext)
//                       └── AAD = caller-supplied string, bound to the
//                           connection.id so a ciphertext stolen from one
//                           row can't be replayed against another.
//
// The 16-byte GCM tag is appended to the ciphertext by the Web Crypto
// implementation; we do not split it out. Callers persist `{iv, ciphertext}`
// as two blob columns (see lib/db/schema.ts).

import "server-only";

const te = new TextEncoder();
const td = new TextDecoder();

/** Subset of the Cloudflare Pages env this module reads. */
export interface CryptoEnv {
  /** Base64 of the 32-byte AES-256 master key. Server-only secret. */
  ENCRYPTION_KEY: string;
}

/**
 * Thrown when AES-GCM tag verification or AAD binding fails — i.e. the
 * ciphertext, IV, or AAD was tampered with, or the wrong master key is in
 * use. Callers should treat this as a security event (audit log + 401/500),
 * never expose the inner message to the client.
 */
export class CryptoIntegrityError extends Error {
  constructor(message = "AES-GCM authentication failed") {
    super(message);
    this.name = "CryptoIntegrityError";
  }
}

// Module-level cache of imported CryptoKeys, keyed by the raw base64 string.
// We cache the Promise itself so two concurrent first-callers await the same
// subtle.importKey() rather than racing. We use Map (not WeakMap, as the
// original task brief suggested) because string keys cannot be WeakMap keys.
const keyCache = new Map<string, Promise<CryptoKey>>();

// Return type is explicitly Uint8Array<ArrayBuffer> (not the default
// <ArrayBufferLike>) so callers can pass the result directly into
// crypto.subtle.* — TS 5.7+ tightened BufferSource to reject the looser
// generic.
function decodeBase64(s: string): Uint8Array<ArrayBuffer> {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function validateAndDecodeKey(env: CryptoEnv): Uint8Array<ArrayBuffer> {
  const raw = env.ENCRYPTION_KEY;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("ENCRYPTION_KEY env var is missing");
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64(raw);
  } catch {
    throw new Error("ENCRYPTION_KEY is not valid base64");
  }
  if (bytes.byteLength !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${bytes.byteLength})`,
    );
  }
  return bytes;
}

async function getMasterKey(env: CryptoEnv): Promise<CryptoKey> {
  const raw = env.ENCRYPTION_KEY;
  const cached = keyCache.get(raw);
  if (cached) return cached;

  // Validate synchronously before touching the cache so a bad key never
  // pollutes it with a rejected Promise.
  const bytes = validateAndDecodeKey(env);
  const promise = crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  keyCache.set(raw, promise);
  // Defensive: if subtle.importKey ever rejects asynchronously (shouldn't,
  // for a validated 32-byte input), evict so the next caller can retry.
  promise.catch(() => keyCache.delete(raw));
  return promise;
}

/**
 * Encrypt one credential string. Produces a fresh random IV per call —
 * never reuse `(key, iv)` for two different plaintexts, that's catastrophic
 * for GCM.
 *
 * @param plaintext  The credential to encrypt (access key, secret, etc.).
 * @param aad        Additional authenticated data. Must be deterministic for
 *                   the row (we use the ULID `connection.id`); supplying a
 *                   different AAD at decrypt time throws CryptoIntegrityError.
 * @param env        Carries the base64 ENCRYPTION_KEY.
 */
export async function encryptCredential(
  plaintext: string,
  aad: string,
  env: CryptoEnv,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const key = await getMasterKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(aad) },
      key,
      te.encode(plaintext),
    ),
  );
  return { iv, ciphertext };
}

/**
 * Decrypt one credential string. Throws {@link CryptoIntegrityError} when the
 * ciphertext, IV, or AAD has been tampered with (or the wrong master key is
 * loaded). Env / configuration errors propagate as plain Error so they
 * bubble to a 5xx, not a 401-style integrity error.
 */
export async function decryptCredential(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  aad: string,
  env: CryptoEnv,
): Promise<string> {
  const key = await getMasterKey(env);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      // Casts: callers may hand us Uint8Array<ArrayBufferLike> (e.g. from D1
      // blob columns); BufferSource accepts the runtime shape, TS just needs
      // the narrower generic. Same applies to encrypt's iv argument.
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: te.encode(aad) },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    // Web Crypto throws OperationError when GCM tag or AAD doesn't verify.
    // We don't preserve the original message — it can leak timing/internal
    // detail, and audit-logging the bare ciphertext is itself a leak.
    throw new CryptoIntegrityError();
  }
  return td.decode(plain);
}
