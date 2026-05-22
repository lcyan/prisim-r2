// tests/unit/api/delete-token.test.ts
//
// Spec for lib/api/delete-token.ts — the HMAC-signed confirmation token
// that backs the destructive object-delete flow. The token is a bearer
// credential for one (userId, bucket, keys[]) intent, so the tests focus
// on the security-relevant invariants:
//
//   * sorting & hashing — keys order MUST NOT change the resulting hash;
//     otherwise a multi-select UI that emits in pick order produces
//     differently-signed tokens that fail to verify.
//   * round-trip — issue + verify with the same inputs succeeds.
//   * expiry — a token past its exp is rejected (5-min TTL).
//   * tamper detection — flipping a single bit, a single character of the
//     signature half, a single key, the userId, or the bucket all reject.
//   * shape parsing — malformed tokens (no dot, garbage exp) reject without
//     leaking which check failed.
//
// Vitest runs in Node so `globalThis.crypto.subtle` is available natively;
// no polyfill required.

import { describe, it, expect } from "vitest";

import {
  DELETE_TOKEN_TTL_SECONDS,
  DeleteTokenError,
  hashKeys,
  issueDeleteToken,
  verifyDeleteToken,
} from "@/lib/api/delete-token";

const env = { AUTH_SECRET: "test-auth-secret-not-base64-decoded" };
const T0 = 1_700_000_000_000; // arbitrary fixed epoch ms

describe("hashKeys", () => {
  it("is stable across input orderings", async () => {
    const a = await hashKeys(["foo", "bar", "baz"]);
    const b = await hashKeys(["baz", "bar", "foo"]);
    const c = await hashKeys(["bar", "baz", "foo"]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("is sensitive to membership (adding a key changes the hash)", async () => {
    const a = await hashKeys(["foo", "bar"]);
    const b = await hashKeys(["foo", "bar", "baz"]);
    expect(a).not.toBe(b);
  });

  it("is sensitive to a single-char edit (suffix matters)", async () => {
    const a = await hashKeys(["logs/2026/a.txt"]);
    const b = await hashKeys(["logs/2026/b.txt"]);
    expect(a).not.toBe(b);
  });

  it("returns 64 hex chars (SHA-256)", async () => {
    const h = await hashKeys(["x"]);
    expect(h).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not mutate the caller's array", async () => {
    const input = ["b", "a", "c"];
    await hashKeys(input);
    expect(input).toEqual(["b", "a", "c"]);
  });
});

describe("issueDeleteToken / verifyDeleteToken — happy path", () => {
  const base = {
    userId: "U01",
    bucket: "my-bucket",
    keys: ["k1", "k2"],
    env,
  };

  it("round-trips successfully and reports the same expiry on both sides", async () => {
    const { token, expiresAt } = await issueDeleteToken({ ...base, now: T0 });
    const verified = await verifyDeleteToken({
      ...base,
      token,
      now: T0 + 1000, // 1s later — still within TTL
    });
    expect(verified.expiresAt).toBe(expiresAt);
  });

  it("expiresAt matches now + TTL (default 5 min)", async () => {
    const { expiresAt } = await issueDeleteToken({ ...base, now: T0 });
    // Token rounds exp down to whole seconds, so the result is a multiple
    // of 1000 ms relative to floor(now/1000)+TTL.
    const expectedExpSec = Math.floor(T0 / 1000) + DELETE_TOKEN_TTL_SECONDS;
    expect(expiresAt).toBe(expectedExpSec * 1000);
  });

  it("verifies regardless of the key order the verifier passes", async () => {
    // Issue with one order, verify with another.
    const { token } = await issueDeleteToken({
      ...base,
      keys: ["a", "b", "c"],
      now: T0,
    });
    await expect(
      verifyDeleteToken({
        ...base,
        keys: ["c", "a", "b"],
        token,
        now: T0,
      }),
    ).resolves.toBeDefined();
  });

  it("token shape is <base64url>.<digits>", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.\d+$/u);
  });
});

describe("verifyDeleteToken — rejection paths", () => {
  const base = {
    userId: "U01",
    bucket: "my-bucket",
    keys: ["k1", "k2"],
    env,
  };

  it("rejects a token issued for a different bucket", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    await expect(
      verifyDeleteToken({
        ...base,
        bucket: "other-bucket",
        token,
        now: T0,
      }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects a token issued for a different user", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    await expect(
      verifyDeleteToken({
        ...base,
        userId: "U02",
        token,
        now: T0,
      }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects when the keys list differs (added key)", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    await expect(
      verifyDeleteToken({
        ...base,
        keys: ["k1", "k2", "k3"],
        token,
        now: T0,
      }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects when one key is replaced (membership-level tamper)", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    await expect(
      verifyDeleteToken({
        ...base,
        keys: ["k1", "k2-tampered"],
        token,
        now: T0,
      }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects an expired token (one second past exp)", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    const past = T0 + (DELETE_TOKEN_TTL_SECONDS + 1) * 1000;
    await expect(
      verifyDeleteToken({ ...base, token, now: past }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects a tampered signature half (single-char swap)", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    const dot = token.lastIndexOf(".");
    const sig = token.slice(0, dot);
    // Flip the first character to a different base64url char. Both candidates
    // exist in the alphabet, so the result is still well-formed — only the
    // HMAC compare should fail.
    const swapped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const tampered = `${swapped}${token.slice(dot)}`;
    await expect(
      verifyDeleteToken({ ...base, token: tampered, now: T0 }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects a tampered exp half (forged later expiry)", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    const dot = token.lastIndexOf(".");
    const sig = token.slice(0, dot);
    const exp = Number(token.slice(dot + 1));
    // Try to extend the token's life by 1h — exp now no longer matches
    // the signed payload, so HMAC compare fails.
    const tampered = `${sig}.${exp + 3600}`;
    await expect(
      verifyDeleteToken({ ...base, token: tampered, now: T0 }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it.each([
    ["empty string", ""],
    ["no dot", "abcdefgABCDEF1234567890"],
    ["dot at end", "abcdefgABCDEF1234567890."],
    ["dot at start", ".1700000900"],
    ["non-digit exp", "abcdefgABCDEF1234567890.NOT_DIGITS"],
    ["too short", "a.b"],
  ])("rejects malformed token: %s", async (_label, token) => {
    await expect(
      verifyDeleteToken({ ...base, token, now: T0 }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });

  it("rejects a token signed by a different AUTH_SECRET", async () => {
    const { token } = await issueDeleteToken({ ...base, now: T0 });
    await expect(
      verifyDeleteToken({
        ...base,
        token,
        env: { AUTH_SECRET: "different-secret" },
        now: T0,
      }),
    ).rejects.toBeInstanceOf(DeleteTokenError);
  });
});
