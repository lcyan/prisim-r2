// lib/auth/config.ts
//
// Edge-safe Auth.js v5 base config (no adapter, no DB calls, no Node APIs).
// This object is used directly by middleware.ts via NextAuth(authConfig).auth,
// which runs in Next.js's edge runtime where Cloudflare Pages bindings
// (getCloudflareContext) are NOT available.
//
// The "full" instance in lib/auth/index.ts extends this object with the
// CredentialsProvider, jwt/session/signOut callbacks, and the D1 adapter —
// none of which middleware needs because the JWT itself encodes whether the
// user is logged in. Database revocation checks happen in the session
// callback (full config), which only runs when route handlers call auth().

import type { NextAuthConfig } from "next-auth";

// Paths that are reachable without a session. Everything else under the
// matcher in middleware.ts is gated. Keep this list narrow on purpose —
// adding a route here removes it from the auth wall.
const PUBLIC_PATHS = ["/", "/login", "/api/auth", "/api/health"];

export const authConfig: NextAuthConfig = {
  pages: { signIn: "/login" },
  trustHost: true,
  session: {
    strategy: "jwt",
    // 7 days; the matching D1 sessions.expires_at is set to the same window
    // in lib/auth/index.ts so revoking a session truly cuts off access at
    // the next auth() call.
    maxAge: 60 * 60 * 24 * 7,
  },
  callbacks: {
    /**
     * Called by middleware on every gated request — returning false redirects
     * to pages.signIn ("/login") with a callbackUrl. We can't check D1 here
     * (no request context on the Edge middleware), so this is a JWT-only
     * presence check. Revocation enforcement runs in the session() callback
     * inside the full config.
     */
    authorized({ auth, request: { nextUrl } }) {
      const path = nextUrl.pathname;
      const isPublic = PUBLIC_PATHS.some(
        (p) => path === p || path.startsWith(`${p}/`),
      );
      if (isPublic) return true;
      return !!auth?.user;
    },
  },
  providers: [],
};
