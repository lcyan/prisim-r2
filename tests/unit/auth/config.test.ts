// tests/unit/auth/config.test.ts
//
// Guards the PUBLIC_PATHS list in lib/auth/config.ts. The list controls
// which routes the edge middleware lets through without a session — a
// regression here (e.g. removing /setup/totp) breaks first-time TOTP
// enrollment because the page can't be reached pre-login.

import { describe, it, expect } from "vitest";
import { authConfig } from "@/lib/auth/config";
import type { Session } from "next-auth";

function authorize(path: string, signedIn: boolean): boolean {
  const auth = signedIn
    ? ({ user: { email: "user@example.com" } } as unknown as Session)
    : null;
  const result = authConfig.callbacks?.authorized?.({
    auth,
    request: {
      nextUrl: { pathname: path } as URL,
    } as Request & { nextUrl: URL },
  } as Parameters<NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>>[0]);
  // The callback may return a boolean or Response; we only branch on boolean.
  return result === true;
}

describe("authConfig.authorized (middleware gate)", () => {
  it("lets /setup/totp through without a session (TOTP enrollment runs pre-login)", () => {
    expect(authorize("/setup/totp", false)).toBe(true);
  });

  it("lets /login, /, /api/auth/*, /api/health through without a session", () => {
    expect(authorize("/", false)).toBe(true);
    expect(authorize("/login", false)).toBe(true);
    expect(authorize("/api/auth/callback/credentials", false)).toBe(true);
    expect(authorize("/api/health", false)).toBe(true);
  });

  it("blocks unauthenticated access to protected routes", () => {
    expect(authorize("/", true)).toBe(true); // signed in is fine
    expect(authorize("/dashboard", false)).toBe(false);
    expect(authorize("/api/connections", false)).toBe(false);
    expect(authorize("/api/r2/presign", false)).toBe(false);
  });

  it("allows signed-in access to protected routes", () => {
    expect(authorize("/dashboard", true)).toBe(true);
    expect(authorize("/api/connections", true)).toBe(true);
  });
});
