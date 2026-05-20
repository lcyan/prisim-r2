// lib/auth/adapter.ts
//
// Minimal D1-backed session/user helpers for Auth.js v5.
//
// IMPORTANT — why this is not a real `Adapter` from "@auth/core/adapters":
//
//   Auth.js v5's Credentials provider can ONLY be paired with the JWT
//   session strategy (the framework throws at startup otherwise). So we run
//   on JWT, but we still want database-backed sessions for revocation,
//   audit, and "log out everywhere" support — exactly what the brief
//   asked for via the sessions.token_hash column.
//
//   The pattern: on sign-in, lib/auth/config.ts generates a ULID session
//   token, calls createSession() here to persist sha256(token) in D1, and
//   stuffs the raw token into the JWT. On every protected request, the
//   session callback calls getSessionAndUser() to confirm the row still
//   exists (revoked sessions = row deleted = re-auth required). signOut
//   deletes the row.
//
//   Functions are shaped like adapter methods so a future migration to a
//   real Auth.js adapter (e.g. when OAuth providers join Credentials) is
//   mostly a rename.

import "server-only";

import { and, eq, gt } from "drizzle-orm";
import { ulid } from "ulid";
import { type Db, schema } from "@/lib/db/client";

const te = new TextEncoder();

/** sha256 of the session token; stored as hex (64 chars) so the column is
 * plain text and indexable. We never persist the raw token. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(token));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface SessionUser {
  id: string;
  email: string;
}

export interface SessionRecord {
  user: SessionUser;
  expiresAt: Date;
}

export function createD1Adapter(db: Db) {
  return {
    async getUserByEmail(email: string): Promise<SessionUser | null> {
      const row = await db.query.users.findFirst({
        where: eq(schema.users.email, email),
        columns: { id: true, email: true, passwordHash: true },
      });
      return row ? { id: row.id, email: row.email } : null;
    },

    /** Used by authorize() — caller compares passwordHash via verifyPassword. */
    async getUserWithPassword(
      email: string,
    ): Promise<(SessionUser & { passwordHash: string }) | null> {
      const row = await db.query.users.findFirst({
        where: eq(schema.users.email, email),
        columns: { id: true, email: true, passwordHash: true },
      });
      return row ?? null;
    },

    async getUserById(id: string): Promise<SessionUser | null> {
      const row = await db.query.users.findFirst({
        where: eq(schema.users.id, id),
        columns: { id: true, email: true },
      });
      return row ?? null;
    },

    /** Persist a new session row. Returns the *raw* token (to be embedded in
     * the JWT) — only the hash is stored. */
    async createSession(args: {
      userId: string;
      expiresAt: Date;
    }): Promise<{ token: string }> {
      const token = ulid();
      await db.insert(schema.sessions).values({
        id: ulid(),
        userId: args.userId,
        tokenHash: await hashSessionToken(token),
        expiresAt: args.expiresAt,
      });
      return { token };
    },

    /** Look up a non-expired session row by its raw token. Does an explicit
     * user join (no drizzle `relations()` declaration needed). Returns null
     * if the session is missing, expired, or its user no longer exists. */
    async getSessionAndUser(token: string): Promise<SessionRecord | null> {
      const tokenHash = await hashSessionToken(token);
      const session = await db.query.sessions.findFirst({
        where: and(
          eq(schema.sessions.tokenHash, tokenHash),
          gt(schema.sessions.expiresAt, new Date()),
        ),
        columns: { userId: true, expiresAt: true },
      });
      if (!session) return null;
      const user = await db.query.users.findFirst({
        where: eq(schema.users.id, session.userId),
        columns: { id: true, email: true },
      });
      if (!user) return null;
      return { user, expiresAt: session.expiresAt };
    },

    /** Idempotent — silently no-ops if the session is already gone. */
    async deleteSession(token: string): Promise<void> {
      const tokenHash = await hashSessionToken(token);
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.tokenHash, tokenHash));
    },
  };
}

export type D1Adapter = ReturnType<typeof createD1Adapter>;
