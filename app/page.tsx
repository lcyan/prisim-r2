import { redirect } from "next/navigation";

import { HomeRedirector } from "@/components/features/dashboard/home-redirector";
import { auth } from "@/lib/auth";

export const runtime = "edge";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  // Hand off to a client component: the destination depends on the
  // persisted Zustand slice (activeConnectionId + activeBucket) which
  // only exists in localStorage. Falls back to /settings/connections
  // when nothing is persisted (first-time user or after sign-out).
  return <HomeRedirector />;
}
