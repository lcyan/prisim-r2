import type { ReactNode } from "react";
import { vi } from "vitest";

let currentPathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

export function MemoryRouterProvider({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  currentPathname = pathname;
  return <>{children}</>;
}
