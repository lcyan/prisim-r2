// app/(dashboard)/layout.tsx
//
// Server-rendered shell for every authenticated dashboard route. middleware.ts
// already redirects unauthenticated requests to /login, but we call auth()
// here too so the header can display the signed-in email — and so a stale
// JWT cookie (session row revoked server-side via the session() callback)
// can't render this page without an email.
//
// Edge runtime is required because we read from D1 via auth() → adapter →
// drizzle on the Cloudflare Pages runtime.

import type { ReactNode } from "react";
import Link from "next/link";

import { auth } from "@/lib/auth";
import { BucketSwitcher } from "@/components/features/dashboard/bucket-switcher";
import { Logo } from "@/components/features/dashboard/logo";
import { SignOutButton } from "@/components/features/dashboard/sign-out-button";

export const runtime = "edge";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="h-[2px] w-full bg-primary" aria-hidden />
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-4">
          <Logo />
          {/* BucketSwitcher reads activeConnectionId from the Zustand store
              and shows a disabled placeholder until the user picks one — so
              it's safe to render on every dashboard page (settings included)
              without coupling to a route-specific layout. */}
          <BucketSwitcher />
        </div>
        <nav className="flex items-center gap-6">
          <Link
            href="/settings/connections"
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground"
          >
            Connections
          </Link>
          {session?.user?.email ? (
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {session.user.email}
              </span>
              <SignOutButton />
            </div>
          ) : null}
        </nav>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
