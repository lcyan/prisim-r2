// playwright.config.ts
//
// E2E config for Prisim R2. Two opinionated choices worth flagging:
//
//   1. webServer runs `pnpm preview`, not `pnpm dev`. `next dev` lacks the
//      Cloudflare bindings (`getRequestContext().env.DB` is undefined), so
//      anything touching D1 returns 500 — including /api/auth. The full
//      next-on-pages + wrangler stack at :8788 is the only thing that
//      mirrors production. Cold start is slow (~30–60s for the build), so
//      timeout is generous.
//
//   2. A dedicated "setup" project performs the credential login once and
//      writes a storageState file under playwright/.auth/. All other
//      projects load that state, so each spec starts already authenticated
//      and we avoid hammering the login route. The file is gitignored.
//
// Browser binaries are NOT installed by `pnpm install` — see
// docs/deploy-runbook.md and the test:e2e script for the install step.

import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const STORAGE_STATE = "playwright/.auth/admin.json";

export default defineConfig({
  testDir: "tests/e2e",

  // Specs themselves create/delete server-side state (connections, objects,
  // shares) against a real R2 throwaway bucket, so they MUST run serially
  // within a worker — but workers can still run in parallel.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Connections form is forgiving but R2 control-plane is not — bake a
    // realistic action timeout instead of the default 5s.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
      },
      dependencies: ["setup"],
      // login.spec.ts must run *without* an authenticated session, so
      // exclude it from the chromium project and let the unauth project
      // below handle it.
      testIgnore: /login\.spec\.ts/,
    },
    {
      name: "chromium-unauth",
      testMatch: /login\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Reuse a running preview when iterating locally; spin one up in CI.
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: "pnpm preview",
        url: BASE_URL,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        // Pipe wrangler logs to the test output so a startup failure (e.g.
        // missing .dev.vars, busy port) is diagnosable from CI logs alone.
        stdout: "pipe",
        stderr: "pipe",
      },
});
