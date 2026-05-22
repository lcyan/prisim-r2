// tests/e2e/connections.spec.ts
//
// Add-connection happy path. Skipped when E2E_R2_TEST_* env vars are
// missing because POST /api/connections performs a real R2 ListBuckets
// probe before persisting — we can't fake it with placeholder values.
//
// Each run creates a uniquely-named connection and tears it down
// afterwards so the spec is rerunnable against the same throwaway R2
// account without polluting the dashboard or audit log indefinitely.

import { test, expect, type Page } from "@playwright/test";

const ACCOUNT_ID = process.env.E2E_R2_ACCOUNT_ID ?? "";
const ACCESS_KEY = process.env.E2E_R2_ACCESS_KEY ?? "";
const SECRET_KEY = process.env.E2E_R2_SECRET_KEY ?? "";

const HAS_R2_CREDS = ACCOUNT_ID && ACCESS_KEY && SECRET_KEY;

test.describe("connections", () => {
  test.skip(
    !HAS_R2_CREDS,
    "E2E_R2_ACCOUNT_ID / E2E_R2_ACCESS_KEY / E2E_R2_SECRET_KEY are required",
  );

  test("creates a connection, lists it with masked credentials, and removes it", async ({
    page,
  }) => {
    const name = `e2e-${Date.now().toString(36)}`;

    await page.goto("/settings/connections");
    await page.getByRole("heading", { name: /r2 connections/i }).waitFor();

    await page.getByRole("button", { name: /add connection/i }).click();

    // AddConnectionDialog renders the form fields with stable labels.
    await page.getByLabel(/^name$/i).fill(name);
    await page.getByLabel(/account id/i).fill(ACCOUNT_ID);
    await page.getByLabel(/access key id/i).fill(ACCESS_KEY);
    await page.getByLabel(/secret access key/i).fill(SECRET_KEY);

    await page.getByRole("button", { name: /test & save/i }).click();

    // sonner toast on success — match the literal title from
    // add-connection-dialog.tsx so a translation change is loud.
    await expect(page.getByText(/connection added/i)).toBeVisible({
      timeout: 30_000, // R2 ListBuckets probe + Pages cold start
    });

    // List row appears with the new connection name and a MASKED access
    // key. The Security Invariant says the raw secret never reaches the
    // browser, so the raw ACCESS_KEY must NOT be substring-present.
    const row = page.getByRole("row").filter({ hasText: name }).first();
    await expect(row).toBeVisible();

    const rowText = (await row.textContent()) ?? "";
    expect(rowText).toContain("****"); // mask separator
    expect(rowText).not.toContain(ACCESS_KEY); // never leak the raw key
    expect(rowText).not.toContain(SECRET_KEY); // never leak the secret

    // Tear down so the next run starts clean.
    await deleteConnectionRow(page, name);
  });
});

async function deleteConnectionRow(page: Page, name: string) {
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await row
    .getByRole("button", { name: new RegExp(`delete ${name}`, "i") })
    .click();
  // DeleteConnectionDialog requires typing the exact connection name to
  // confirm. The label text is dynamic ("Type <name> to confirm") so we
  // match the surrounding "to confirm" suffix instead of the full string.
  const confirm = page.getByLabel(/to confirm/i);
  await confirm.fill(name);
  await page.getByRole("button", { name: /^delete connection$/i }).click();
  await expect(row).toBeHidden({ timeout: 10_000 });
}
