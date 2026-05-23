import { Suspense } from "react";
import { redirect } from "next/navigation";

import { HomeRedirector } from "@/components/features/dashboard/home-redirector";
import { auth } from "@/lib/auth";

export const runtime = "edge";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  // Hand off to a client component: dashboard-first. The HomeRedirector
  // jumps to /dashboard unconditionally, unless a same-origin callbackUrl
  // was passed in the query string (e.g. middleware preserved an in-flight
  // navigation across the auth gate). Suspense is required because
  // useSearchParams must be wrapped on Next.js 15.
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <HomeRedirector />
    </Suspense>
  );
}
