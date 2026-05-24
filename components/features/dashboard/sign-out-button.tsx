"use client";

// components/features/dashboard/sign-out-button.tsx
//
// Calls next-auth's client-side signOut() so the JWT cookie is cleared and
// the server's signOut event fires (which deletes the D1 sessions row and
// writes an audit_log entry — see lib/auth/index.ts).
//
// Using the client helper instead of a server action keeps the dashboard
// layout's render path strictly read-only (auth() to fetch the session,
// nothing else). A future global "log out everywhere" feature can live
// next to this without re-architecting the layout.

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => {
        void signOut({ callbackUrl: "/login" });
      }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <LogOut className="h-3 w-3" />
      退出登录
    </button>
  );
}
