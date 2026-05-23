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
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";

export const runtime = "edge";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/login");
  }
  return <AppShell user={{ email: session.user.email }}>{children}</AppShell>;
}
