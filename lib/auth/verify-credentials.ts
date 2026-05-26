// lib/auth/verify-credentials.ts
//
// The pure credential verifier — three branches, all sharing a single audit
// trail, rate-limit budget, and decryption path. The NextAuth Credentials
// provider in lib/auth/index.ts delegates to `verifyCredentials`; tests can
// import it directly without standing up the full NextAuth() runtime
// (next-auth's top-level `next/server` import is unresolvable under
// vitest/jsdom).
//
// Branches
// --------
//   A) signInGrant: a single-use post-enrollment ticket. Skips password +
//      OTP and is consumed in one D1 UPDATE. Used by /setup/totp after the
//      user confirms the QR pairing — the page knows the user is the same
//      person who just typed their password seconds ago.
//   B) email + password + (OTP | recovery code): the steady-state login.
//      The rate-limit counter is incremented BEFORE any other check so a
//      password-only brute force can't bypass it. Once the password is OK,
//      OTP is matched against the AES-GCM-decrypted shared secret, the
//      step is recorded against the replay guard, and (if recovery code
//      shaped) the code is single-use-consumed instead.
//
// Security invariants honoured here:
//   - Plaintext credentials never leave RAM. The base32 TOTP secret is
//     decrypted, verified, then dropped — no logs, no error messages.
//   - Audit rows are written for every outcome (success + each failure
//     reason). `errorMsg` is a short closed-set string ("password_invalid",
//     "replay", "ratelimit", …), never user-supplied content.
//   - AAD for AES-GCM decryption is `row.id` (the users.id ULID), matching
//     the encryption side. A ciphertext copied between rows fails the tag.

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { ApiError } from "@/lib/api/errors";
import { enforceLimit, RateLimitBundles, RateLimitPolicies } from "@/lib/api/rate-limit";
import { logAudit } from "@/lib/audit/log";
import { decryptCredential } from "@/lib/crypto/aes-gcm";
import { getDb, type DbEnv } from "@/lib/db/client";

import {
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-codes";
import { base32Decode, verifyTotpCode } from "./totp";
import {
  consumeRecoveryCode,
  consumeSignInGrant,
  getReplayGuardStep,
  getUserTotpRow,
  upsertReplayGuard,
} from "./totp-store";
import { createD1Adapter, type SessionUser } from "./adapter";
import { verifyPassword, verifyPasswordOrDummy } from "./password";

export interface VerifyEnv extends DbEnv {
  ENCRYPTION_KEY: string;
}

export interface VerifyCredentialsInput {
  email: string;
  password?: string;
  otp?: string;
  signInGrant?: string;
  /** Client IP extracted by the NextAuth `authorize` wrapper. When provided,
   *  triggers an early IP-keyed rate-limit so credential stuffing against
   *  unknown emails (which never reach the per-user bucket) is still
   *  bounded. Unit tests may omit this — the gate is skipped when absent. */
  ip?: string;
}

/**
 * The function NextAuth Credentials.authorize delegates to. Returns the
 * session user on success, `null` on any failure (NextAuth treats both
 * "no match" and "throw" as a sign-in failure, so we collapse the two for
 * cleaner audit semantics).
 */
export async function verifyCredentials(
  input: VerifyCredentialsInput,
): Promise<SessionUser | null> {
  const env = getCloudflareContext().env as unknown as VerifyEnv;
  const db = getDb(env);
  const adapter = createD1Adapter(db);

  // Pre-auth IP gate — fires for every login attempt (including unknown
  // emails and signInGrant submissions) so the per-user bucket below isn't
  // the first defense. Reuses the established `login:ip` bucket
  // (10 attempts per 5 min) shared with any future credential routes.
  if (input.ip) {
    try {
      await enforceLimit(env.DB, [RateLimitPolicies.loginByIp(input.ip)]);
    } catch (e) {
      if (e instanceof ApiError) {
        await logAudit({
          userId: null,
          op: "auth.login",
          status: "failure",
          errorMsg: "ratelimit_ip",
        });
        return null;
      }
      throw e;
    }
  }

  // ── Branch A: signInGrant ───────────────────────────────────
  if (input.signInGrant) {
    const grantedUserId = await consumeSignInGrant(db, input.signInGrant);
    if (!grantedUserId) {
      await logAudit({
        userId: null,
        op: "auth.signin_grant.consume",
        status: "failure",
        errorMsg: "consumed_or_expired",
      });
      return null;
    }
    const user = await adapter.getUserById(grantedUserId);
    if (!user) return null;
    await logAudit({
      userId: grantedUserId,
      op: "auth.signin_grant.consume",
      status: "success",
    });
    return user;
  }

  // ── Branch B: email + password + (otp | recovery code) ─────
  if (!input.email || !input.password) return null;
  const row = await adapter.getUserWithPassword(input.email);
  if (!row) {
    // Anti-enumeration: pay the PBKDF2 cost even when the email doesn't
    // exist so response wall-clock can't distinguish "no such email" from
    // "wrong password". Collapses into the generic null return below.
    await verifyPasswordOrDummy(input.password, null);
    return null;
  }

  // Run the password compare up-front but DO NOT short-circuit on it — we
  // must increment the per-user rate-limit counter even on wrong passwords,
  // otherwise an attacker pays no cost for credential stuffing.
  const passwordOk = await verifyPassword(input.password, row.passwordHash);

  try {
    await enforceLimit(env.DB, RateLimitBundles.authTotpVerifyByUser(row.id));
  } catch (e) {
    if (e instanceof ApiError) {
      await logAudit({
        userId: row.id,
        op: "auth.totp.verify",
        status: "failure",
        errorMsg: "ratelimit",
      });
      return null;
    }
    throw e;
  }

  if (!passwordOk) {
    await logAudit({
      userId: row.id,
      op: "auth.totp.verify",
      status: "failure",
      errorMsg: "password_invalid",
    });
    return null;
  }

  const totpRow = await getUserTotpRow(db, row.id);
  if (!totpRow?.totpEnabled || !totpRow.secretCiphertext || !totpRow.secretIv) {
    // Defensive: the login UI runs the preflight endpoint first and routes
    // unenrolled users to /setup/totp. A request hitting here means the
    // client skipped preflight — refuse.
    await logAudit({
      userId: row.id,
      op: "auth.totp.verify",
      status: "failure",
      errorMsg: "enrollment_required",
    });
    return null;
  }

  if (!input.otp) {
    await logAudit({
      userId: row.id,
      op: "auth.totp.verify",
      status: "failure",
      errorMsg: "code_missing",
    });
    return null;
  }

  let secretBase32: string;
  try {
    secretBase32 = await decryptCredential(
      totpRow.secretCiphertext,
      totpRow.secretIv,
      row.id,
      env,
    );
  } catch {
    await logAudit({
      userId: row.id,
      op: "auth.totp.verify",
      status: "failure",
      errorMsg: "decrypt_failed",
    });
    return null;
  }
  const secret = base32Decode(secretBase32);

  // 6-digit numeric → TOTP path; anything else → recovery code path.
  if (/^\d{6}$/.test(input.otp)) {
    const verifyResult = await verifyTotpCode(
      secret,
      input.otp,
      Math.floor(Date.now() / 1000),
    );
    if (!verifyResult.ok) {
      await logAudit({
        userId: row.id,
        op: "auth.totp.verify",
        status: "failure",
        errorMsg: "code_invalid",
      });
      return null;
    }
    const last = await getReplayGuardStep(db, row.id);
    const matchedStep = verifyResult.matchedStep!;
    if (last != null && matchedStep <= last) {
      await logAudit({
        userId: row.id,
        op: "auth.totp.verify",
        status: "failure",
        errorMsg: "replay",
      });
      return null;
    }
    await upsertReplayGuard(db, {
      userId: row.id,
      step: matchedStep,
    });
    await logAudit({
      userId: row.id,
      op: "auth.totp.verify",
      status: "success",
    });
    return { id: row.id, email: row.email };
  }

  // Recovery-code path.
  const normalized = normalizeRecoveryCode(input.otp);
  if (!normalized) {
    await logAudit({
      userId: row.id,
      op: "auth.recovery_code.consume",
      status: "failure",
      errorMsg: "no_match",
    });
    return null;
  }
  const hash = await hashRecoveryCode(normalized, row.id);
  const ok = await consumeRecoveryCode(db, { userId: row.id, hash });
  if (!ok) {
    await logAudit({
      userId: row.id,
      op: "auth.recovery_code.consume",
      status: "failure",
      errorMsg: "no_match",
    });
    return null;
  }
  await logAudit({
    userId: row.id,
    op: "auth.recovery_code.consume",
    status: "success",
  });
  return { id: row.id, email: row.email };
}
