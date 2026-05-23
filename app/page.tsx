import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

export const runtime = "edge";

export default async function HomePage() {
  const session = await auth();
  redirect(session?.user ? "/settings/connections" : "/login");
}
