"use client";

// App-wide client providers. Mounted from app/layout.tsx so every page
// (login, dashboard, settings) shares the same QueryClient and Toaster
// surface.
//
// QueryClient is stored in useState so it survives client-side navigation
// (Next.js does NOT unmount this component between route changes) yet is
// not shared across SSR requests — each browser session gets its own
// instance, avoiding the "leaked query results across users" hazard the
// TanStack docs warn about.
//
// next-themes is mounted with attribute="data-theme" so we can drive three
// independent brand themes (blue / orange / green) defined as token sets in
// app/globals.css under `[data-theme="..."]` blocks — none of which is a
// dark variant, so the shadcn `dark:` variant pathway is intentionally
// unused here. defaultTheme="blue" matches the seeded brand; users opt
// into orange/green via the future theme switcher, and their choice is
// persisted under storageKey="prisim-r2-theme" so reloads and cross-tab
// reads stay in sync. enableSystem={false} keeps next-themes from probing
// `prefers-color-scheme` (we're not light/dark gated), and
// enableColorScheme={false} stops next-themes from writing the `color-scheme`
// CSS property on <html> — our themes manage that themselves via tokens, and
// letting next-themes force `color-scheme: light` here would break browser
// form-control rendering when a token set wants a different scheme.
// suppressHydrationWarning lives on <html> (in app/layout.tsx) so the
// data-theme attribute next-themes injects before React hydrates doesn't
// trigger a hydration mismatch warning.

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/sonner";
import { UploadDrawerContainer } from "@/components/features/upload/upload-drawer-container";
import { UploadQueueProvider } from "@/components/features/upload/upload-queue-provider";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 30s stale window matches the audit-log refresh cadence in the
            // PRD; long enough to dedupe table re-renders, short enough that
            // a user adding a connection in another tab sees it on next
            // focus without a manual refetch.
            staleTime: 30_000,
            // Auth + CSRF failures should NOT be retried (will just compound
            // the rate-limit budget). One retry for transient 5xx is fine.
            retry: 1,
            refetchOnWindowFocus: true,
          },
          mutations: {
            // Mutations are user-initiated; failing twice silently is worse
            // than letting the form surface the error.
            retry: 0,
          },
        },
      }),
  );

  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="blue"
      themes={["blue", "orange", "green"]}
      storageKey="prisim-r2-theme"
      enableSystem={false}
      enableColorScheme={false}
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        {children}
        {/* UploadQueueProvider starts the dispatcher once; the drawer is
            mounted globally so the queue surface follows the user across
            routes. Both render no DOM until there's something to show. */}
        <UploadQueueProvider />
        <UploadDrawerContainer />
        <Toaster position="top-right" richColors closeButton />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
