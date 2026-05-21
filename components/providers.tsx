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
// next-themes is mounted with attribute="class" + suppressHydrationWarning
// so the shadcn `dark:` variants light up correctly. We pin defaultTheme
// to "light" until a theme toggle exists in the UI, but the provider is
// here so the sonner Toaster (which reads useTheme()) doesn't fall back
// to undefined and crash in production builds.

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
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
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
