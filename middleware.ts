// middleware.ts
//
// Edge middleware — gates every non-public route behind a valid session.
//
// Uses the SPLIT config from lib/auth/config.ts (no adapter, no D1) because
// Next.js middleware runs in the standalone Edge runtime where
// getRequestContext() is not available. The authConfig.authorized callback
// is the actual gate; it returns false for unauthenticated requests to
// non-public paths, which makes Auth.js redirect to /login with a
// callbackUrl back to the originally requested URL.
//
// Database revocation enforcement happens later, in lib/auth/index.ts's
// session() callback (which DOES have request context because it runs
// inside route handlers).

import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/config";

export default NextAuth(authConfig).auth;

export const config = {
  // Skip Next internals, static assets, and the favicon. The authConfig's
  // authorized() callback decides which of the remaining paths are public.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|css|js|map)).*)"],
};
