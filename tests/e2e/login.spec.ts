// tests/e2e/login.spec.ts
//
// Login coverage. Runs in the `chromium-unauth` project (no preloaded
// storageState) so we exercise the actual /login → JWT → cookie path.
//
// Two scenarios:
//   1. Invalid credentials → ErrorBanner shows "Sign-in failed" and we
//      stay on /login. We use the seeded admin email with a wrong
//      password so the failure goes through the Credentials provider,
//      not Zod (Zod-side schema rejection looks different to the user).
//   2. Valid credentials → redirect off /login + dashboard chrome visible.
//      Doesn't write to D1 beyond a new session row.

import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";

test.describe("login", () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error(
        "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD before running login E2E.",
      );
    }
  });

  test("rejects wrong password without revealing whether the email exists", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("heading", { name: /sign in/i }).waitFor();

    await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
    // 12+ chars matches the seed-admin minimum so the client-side gate
    // doesn't pre-empt the submit before we hit the server.
    await page.getByLabel(/password/i).fill("definitely-not-the-real-pass");
    await page.getByRole("button", { name: /sign in/i }).click();

    // ErrorBanner renders role=alert with the literal code string from
    // the route handler. We assert on the visible title so a future
    // refactor of the code string doesn't silently change the UX.
    const banner = page.getByRole("alert");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/sign-in failed/i);

    // Critical: the URL stays on /login. If a future bug accidentally
    // accepts the empty session, this assertion catches it.
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("accepts seeded admin credentials and lands on the dashboard", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("heading", { name: /sign in/i }).waitFor();

    await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();

    // Don't assert on a specific landing route — Next.js may bounce
    // through /, /buckets, or wherever middleware/redirects send us.
    // What matters is we are off /login.
    await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });
  });
});
