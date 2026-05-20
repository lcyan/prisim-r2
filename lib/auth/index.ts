// lib/auth/index.ts
//
// Full Auth.js v5 instance — used by app/api/auth/[...nextauth]/route.ts,
// server actions, and any server-side auth() call. NOT imported by
// middleware.ts (middleware uses lib/auth/config.ts directly to stay
// Edge-safe; see that file for the rationale).
//
// Architecture choice: Auth.js v5's Credentials provider only supports the
// JWT session strategy. We layer database-backed sessions on top by minting
// a ULID session token in the jwt() callback on sign-in, storing
// sha256(token) in D1 (sessions.token_hash), embedding the raw token in the
// JWT, and validating against D1 on every session() call. signOut deletes
// the row, which immediately revokes the JWT on the next auth() check.

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getRequestContext } from "@cloudflare/next-on-pages";

import { getDb, type DbEnv } from "@/lib/db/client";
import { createD1Adapter } from "./adapter";
import { authConfig } from "./config";
import { verifyPassword } from "./password";

const SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000; // 7 days, matches authConfig

/** Extra fields we stash on the JWT. Augmenting next-auth's JWT interface
 * fights the v5 module resolution under tsconfig moduleResolution:bundler,
 * so we just narrow with a type assertion at each callsite.
 *
 * `csrfToken` is the *raw* token (not the hash) — required so /api/csrf can
 * surface it to the browser as a cookie. It is NEVER exposed via the
 * Session object (which is sent to the client as JSON). The double-submit
 * defense lives in lib/api/middleware.requireCsrf, not in JWT presence. */
interface SessionJWT {
  sessionToken?: string;
  userId?: string;
  csrfToken?: string;
}

interface AuthEnv extends DbEnv {
  AUTH_SECRET?: string;
}

function getEnv(): AuthEnv {
  return getRequestContext().env as unknown as AuthEnv;
}

function getAdapter() {
  return createD1Adapter(getDb(getEnv()));
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const email = typeof creds?.email === "string" ? creds.email : null;
        const password =
          typeof creds?.password === "string" ? creds.password : null;
        if (!email || !password) return null;

        const adapter = getAdapter();
        const row = await adapter.getUserWithPassword(email);
        if (!row) return null;

        const ok = await verifyPassword(password, row.passwordHash);
        if (!ok) return null;
        return { id: row.id, email: row.email };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,

    /**
     * Runs every JWT (sign-in + every refresh on auth() call). On the
     * initial sign-in (`user` is populated, trigger === "signIn") we mint
     * a D1 session row and stash the raw token in the JWT — subsequent
     * calls keep the token unchanged.
     */
    async jwt({ token, user, trigger }) {
      if (user && trigger === "signIn" && user.id) {
        const adapter = getAdapter();
        const { token: sessionToken, csrfToken } = await adapter.createSession({
          userId: user.id,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        });
        const t = token as typeof token & SessionJWT;
        t.sessionToken = sessionToken;
        t.userId = user.id;
        t.csrfToken = csrfToken;
      }
      return token;
    },

    /**
     * Revocation gate: validate the JWT's sessionToken against D1. Missing
     * or expired row → return a "logged-out" session shape, which makes
     * auth() return null and the authorized() callback redirect to /login
     * on the next request.
     */
    async session({ session, token }) {
      const t = token as typeof token & SessionJWT;
      const sessionToken =
        typeof t.sessionToken === "string" ? t.sessionToken : null;
      if (!sessionToken) return session;

      const record = await getAdapter().getSessionAndUser(sessionToken);
      if (!record) {
        return {
          ...session,
          user: undefined as never,
          expires: new Date(0).toISOString(),
        };
      }
      session.user = {
        ...session.user,
        id: record.user.id,
        email: record.user.email,
      };
      return session;
    },
  },
  events: {
    /** Delete the D1 session row so the JWT can never resolve again. */
    async signOut(message) {
      const tokenObj =
        "token" in message && message.token
          ? (message.token as SessionJWT)
          : null;
      const sessionToken =
        tokenObj && typeof tokenObj.sessionToken === "string"
          ? tokenObj.sessionToken
          : null;
      if (sessionToken) {
        await getAdapter().deleteSession(sessionToken);
      }
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
    };
  }
}
