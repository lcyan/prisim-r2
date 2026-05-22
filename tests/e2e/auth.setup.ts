// tests/e2e/auth.setup.ts
//
// Runs once before the authenticated spec projects. Performs a real
// credentials login against the running preview server and writes a
// reusable storageState file. All other specs in the `chromium` project
// pick this state up automatically (see playwright.config.ts).
//
// Why a separate "setup" project instead of beforeAll in each spec:
//   * Login costs a full Cloudflare-Pages cold start round-trip. Running
//     it once cuts ~5–10s off every additional spec.
//   * A failed login fails the setup project and skips downstream specs
//     with a clear root-cause message instead of one ambiguous timeout
//     per spec file.
//
// Why we read credentials from the environment rather than hardcoding:
//   * The seed-admin.ts script bakes the same values into D1. CI sets
//     E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD as repo secrets; locally we
//     read them from `.dev.vars` or the developer's shell.
//   * No credentials should ever land in git. The defaults below are
//     placeholders that intentionally fail closed if env is missing.

import path from "node:path";
import { test as setup, expect } from "@playwright/test";

const STORAGE_STATE = path.join("playwright/.auth/admin.json");

setup("authenticate as admin", async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD must be set before running E2E specs. " +
        "Seed the admin row first (see docs/deploy-runbook.md) and export the same " +
        "values in your shell or CI environment.",
    );
  }

  await page.goto("/login");

  // The form is rendered inside a Suspense boundary while useSearchParams
  // resolves. Wait for the inputs to be in the live DOM, not just the
  // skeleton, before interacting.
  await page.getByRole("heading", { name: /sign in/i }).waitFor();

  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // On success the form router.replaces() to callbackUrl ("/"). Any of:
  //   - URL leaves /login
  //   - "/" or "/buckets" is reachable in the authenticated chrome
  // is acceptable. The strongest signal that the session cookie was
  // accepted is that we *don't* bounce back to /login when fetching "/".
  await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 15_000 });

  // Now persist the cookies + localStorage so subsequent specs reuse
  // the JWT + CSRF cookie. Auth.js v5 stores the session token in an
  // httpOnly cookie; CSRF token is in a separate readable cookie set
  // by GET /api/csrf — both are captured by storageState.
  await page.context().storageState({ path: STORAGE_STATE });
});
