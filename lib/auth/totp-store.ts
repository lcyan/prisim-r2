// lib/auth/totp-store.ts
//
// D1 access for the TOTP feature. All drizzle queries live here so the
// route handlers stay focused on validation + control flow. Mirrors the
// "adapter pattern" used by lib/auth/adapter.ts.

import "server-only";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";

import { type Db, schema } from "@/lib/db/client";

const te = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/* ─── enrollment grants ────────────────────────────────────── */

export interface CreateEnrollmentInput {
  userId: string;
  grant: string;
  secretCiphertext: Uint8Array;
  secretIv: Uint8Array;
  ttlMs: number;
}

export async function createEnrollment(
  db: Db,
  input: CreateEnrollmentInput,
): Promise<void> {
  const grantHash = await sha256Hex(input.grant);
  await db
    .delete(schema.totpEnrollments)
    .where(eq(schema.totpEnrollments.userId, input.userId));
  await db.insert(schema.totpEnrollments).values({
    id: ulid(),
    userId: input.userId,
    grantHash,
    secretCiphertext: Buffer.from(input.secretCiphertext),
    secretIv: Buffer.from(input.secretIv),
    expiresAt: new Date(Date.now() + input.ttlMs),
  });
}

export interface ConsumedEnrollment {
  secretCiphertext: Uint8Array;
  secretIv: Uint8Array;
}

export async function consumeEnrollment(
  db: Db,
  input: { userId: string; grant: string },
): Promise<ConsumedEnrollment | null> {
  const grantHash = await sha256Hex(input.grant);
  const row = await db.query.totpEnrollments.findFirst({
    where: and(
      eq(schema.totpEnrollments.userId, input.userId),
      eq(schema.totpEnrollments.grantHash, grantHash),
      gt(schema.totpEnrollments.expiresAt, new Date()),
    ),
  });
  if (!row) return null;
  await db
    .delete(schema.totpEnrollments)
    .where(eq(schema.totpEnrollments.id, row.id));
  return {
    secretCiphertext: new Uint8Array(row.secretCiphertext),
    secretIv: new Uint8Array(row.secretIv),
  };
}

/* ─── user TOTP columns ────────────────────────────────────── */

export async function upsertUserTotp(
  db: Db,
  input: { userId: string; secretCiphertext: Uint8Array; secretIv: Uint8Array },
): Promise<void> {
  await db
    .update(schema.users)
    .set({
      totpSecretCiphertext: Buffer.from(input.secretCiphertext),
      totpSecretIv: Buffer.from(input.secretIv),
      totpEnabled: true,
      totpConfirmedAt: new Date(),
    })
    .where(eq(schema.users.id, input.userId));
}

export async function getUserTotpRow(
  db: Db,
  userId: string,
): Promise<{
  totpEnabled: boolean;
  secretCiphertext: Uint8Array | null;
  secretIv: Uint8Array | null;
} | null> {
  const row = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: {
      totpEnabled: true,
      totpSecretCiphertext: true,
      totpSecretIv: true,
    },
  });
  if (!row) return null;
  return {
    totpEnabled: row.totpEnabled,
    secretCiphertext: row.totpSecretCiphertext
      ? new Uint8Array(row.totpSecretCiphertext)
      : null,
    secretIv: row.totpSecretIv ? new Uint8Array(row.totpSecretIv) : null,
  };
}

/* ─── recovery codes ───────────────────────────────────────── */

export async function insertRecoveryCodesForUser(
  db: Db,
  input: { userId: string; hashes: string[] },
): Promise<void> {
  await db
    .delete(schema.recoveryCodes)
    .where(eq(schema.recoveryCodes.userId, input.userId));
  if (input.hashes.length === 0) return;
  const rows = input.hashes.map((codeHash) => ({
    id: ulid(),
    userId: input.userId,
    codeHash,
  }));
  await db.insert(schema.recoveryCodes).values(rows);
}

export async function consumeRecoveryCode(
  db: Db,
  input: { userId: string; hash: string },
): Promise<boolean> {
  const updated = await db
    .update(schema.recoveryCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.recoveryCodes.userId, input.userId),
        eq(schema.recoveryCodes.codeHash, input.hash),
        isNull(schema.recoveryCodes.consumedAt),
      ),
    )
    .returning({ id: schema.recoveryCodes.id });
  return updated.length > 0;
}

export async function countActiveRecoveryCodes(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.recoveryCodes)
    .where(
      and(
        eq(schema.recoveryCodes.userId, userId),
        isNull(schema.recoveryCodes.consumedAt),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/* ─── replay guard ─────────────────────────────────────────── */

export async function getReplayGuardStep(
  db: Db,
  userId: string,
): Promise<number | null> {
  const row = await db.query.totpReplayGuard.findFirst({
    where: eq(schema.totpReplayGuard.userId, userId),
  });
  return row ? row.lastStep : null;
}

export async function upsertReplayGuard(
  db: Db,
  input: { userId: string; step: number },
): Promise<void> {
  const existing = await db.query.totpReplayGuard.findFirst({
    where: eq(schema.totpReplayGuard.userId, input.userId),
  });
  if (existing) {
    await db
      .update(schema.totpReplayGuard)
      .set({ lastStep: input.step, updatedAt: new Date() })
      .where(eq(schema.totpReplayGuard.userId, input.userId));
  } else {
    await db.insert(schema.totpReplayGuard).values({
      userId: input.userId,
      lastStep: input.step,
      updatedAt: new Date(),
    });
  }
}

/* ─── sign-in grants ───────────────────────────────────────── */

export async function createSignInGrant(
  db: Db,
  input: { userId: string; grant: string; ttlMs: number },
): Promise<void> {
  const grantHash = await sha256Hex(input.grant);
  await db.insert(schema.signInGrants).values({
    id: ulid(),
    userId: input.userId,
    grantHash,
    expiresAt: new Date(Date.now() + input.ttlMs),
  });
}

export async function consumeSignInGrant(
  db: Db,
  grant: string,
): Promise<string | null> {
  const grantHash = await sha256Hex(grant);
  const updated = await db
    .update(schema.signInGrants)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.signInGrants.grantHash, grantHash),
        isNull(schema.signInGrants.consumedAt),
        gt(schema.signInGrants.expiresAt, new Date()),
      ),
    )
    .returning({ userId: schema.signInGrants.userId });
  return updated[0]?.userId ?? null;
}
