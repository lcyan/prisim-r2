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
import { getCloudflareContext } from "@opennextjs/cloudflare";

import { logAudit } from "@/lib/audit/log";
import { getDb, type DbEnv } from "@/lib/db/client";
import { getClientIp } from "@/lib/api/rate-limit";
import { createD1Adapter } from "./adapter";
import { authConfig } from "./config";
import { verifyCredentials } from "./verify-credentials";

// Re-export so callers (and tests, when not constrained by the next-auth
// import side-effect) can keep importing the verifier from "@/lib/auth".
export { verifyCredentials } from "./verify-credentials";

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
  return getCloudflareContext().env as unknown as AuthEnv;
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
        otp: { label: "OTP", type: "text" },
        signInGrant: { label: "SignIn Grant", type: "text" },
      },
      async authorize(creds, request) {
        // Coerce inputs to typed shapes; everything beyond this point lives
        // in verifyCredentials so the unit tests can exercise it without
        // standing up the full NextAuth runtime.
        const email = typeof creds?.email === "string" ? creds.email : "";
        const password =
          typeof creds?.password === "string" ? creds.password : undefined;
        const otp =
          typeof creds?.otp === "string" && creds.otp.length > 0
            ? creds.otp
            : undefined;
        const signInGrant =
          typeof creds?.signInGrant === "string" && creds.signInGrant.length > 0
            ? creds.signInGrant
            : undefined;
        // IP feeds the early loginByIp gate inside verifyCredentials. We
        // tolerate the v5 typing where `request` may be undefined under some
        // call shapes — fall back to "unknown" so the bucket still applies.
        const ip =
          request instanceof Request ? getClientIp(request) : "unknown";
        return verifyCredentials({ email, password, otp, signInGrant, ip });
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
    /**
     * Successful sign-in. We have user.id but no Request — Auth.js v5
     * doesn't surface req to events. IP/UA end up NULL here; the
     * /api/auth/callback/credentials POST wrapper in route.ts records
     * the *failed* attempts (where we DO have req but no user).
     */
    async signIn(message) {
      const userId =
        message.user && typeof message.user.id === "string"
          ? message.user.id
          : null;
      if (!userId) return;
      await logAudit({ userId, op: "auth.login", status: "success" });
    },

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
      const userId =
        tokenObj && typeof tokenObj.userId === "string"
          ? tokenObj.userId
          : null;
      if (sessionToken) {
        await getAdapter().deleteSession(sessionToken);
      }
      // Log even when sessionToken was missing — a logout request with no
      // server-side session row still represents user intent worth auditing.
      await logAudit({ userId, op: "auth.logout", status: "success" });
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
