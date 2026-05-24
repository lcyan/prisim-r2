import { useState, type ReactNode } from "react";
import { vi } from "vitest";

// Holder object reassigned by setMockPathname/MemoryRouterProvider.
// vi.mock's factory closure reads .value at each usePathname() call.
const router = { pathname: "/" };

vi.mock("next/navigation", () => ({
  usePathname: () => router.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

export function setMockPathname(pathname: string) {
  router.pathname = pathname;
}

export function MemoryRouterProvider({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  // useState lazy initializer runs once at mount, before children render.
  // React treats this as state-construction (not render-time side effect),
  // so the react-hooks/globals rule is satisfied.
  useState(() => {
    router.pathname = pathname;
    return null;
  });
  return <>{children}</>;
}
