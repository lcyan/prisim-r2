// tests/e2e/share.spec.ts
//
// Share link creation + visibility + delete-record round trip. Covers:
//
//   1. Open the per-row Share dialog, pick a TTL, click "Create link",
//      and verify the post-mint view shows a readable presigned URL with
//      the expected R2 host shape.
//   2. The newly-minted record appears on /shares with the same key.
//   3. Clicking "Delete" on /shares opens the warning dialog ("URL itself
//      is NOT revoked"), and confirming removes the row.
//
// Why E2E and not Vitest:
//   * The dialog state machine has three rendered surfaces (pre-mint,
//     pending, post-mint) and a 1Hz countdown. Vitest can cover the
//     formatter in isolation, but the wire-up plus the share-list
//     refresh after mint is only exercised end-to-end here.
//   * The /shares page lists records from D1 written by the create
//     route — confirming the read-after-write through the real Pages
//     edge runtime is exactly what production sees.

import { test, expect } from "@playwright/test";

import {
  E2E_ENV_SKIP_REASON,
  ensureTestConnection,
  readE2EEnv,
  setActiveConnection,
  uploadObjectViaApi,
  browseHref,
} from "./fixtures";

const env = readE2EEnv();

test.describe("shares", () => {
  test.skip(!env, E2E_ENV_SKIP_REASON);

  let baseURL: string;
  let cid: string;

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!env) return;
    baseURL =
      testInfo.project.use.baseURL ??
      process.env.E2E_BASE_URL ??
      "http://localhost:8788";
    const page = await browser.newPage();
    const created = await ensureTestConnection({ page, env, baseURL });
    cid = created.id;
    await page.close();
  });

  test("creates a share link, lists it, and removes the record", async ({
    page,
  }) => {
    if (!env) return;
    await setActiveConnection(page, cid, env.bucket);

    const key = `e2e/${stamp()}-share.txt`;
    await uploadObjectViaApi({
      page,
      baseURL,
      cid,
      bucket: env.bucket,
      key,
      body: "share-me\n",
      contentType: "text/plain",
    });

    await page.goto(browseHref(env.bucket, "e2e/"));
    const row = page
      .getByRole("row")
      .filter({ hasText: keyName(key) })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Hover the row to materialise the action icons, then click Share.
    await row.hover();
    await row.getByLabel(/^share$/i).click();

    await expect(
      page.getByRole("heading", { name: /share object/i }),
    ).toBeVisible();

    // Pick the shortest TTL so the spec leaves the lightest possible
    // footprint on the throwaway bucket's quota. The 1-hour button uses
    // aria-pressed; we drive it via accessible name.
    await page.getByRole("button", { name: /^1 hour/i }).click();
    await page.getByRole("button", { name: /^create link$/i }).click();

    // Post-mint surface: the heading text changes and the URL field
    // appears with aria-label "Presigned share URL". Asserting on the
    // URL's *shape* (must include the R2 host) catches the catastrophic
    // case where the API returns a relative path or a stray placeholder.
    await expect(
      page.getByRole("heading", { name: /share link ready/i }),
    ).toBeVisible({ timeout: 15_000 });
    const urlField = page.getByLabel(/presigned share url/i);
    await expect(urlField).toBeVisible();
    const value = await urlField.inputValue();
    expect(value).toMatch(/^https:\/\/[^.]+\.r2\.cloudflarestorage\.com\//);
    expect(value).toContain(encodeURIComponent(keyName(key)));

    // Close the dialog and navigate to /shares to confirm the record
    // was persisted.
    await page.getByRole("button", { name: /^done$/i }).click();

    await page.goto("/shares");
    const shareRow = page.getByRole("row").filter({ hasText: key }).first();
    await expect(shareRow).toBeVisible({ timeout: 15_000 });

    // Tear down the record — the URL itself stays valid until the 1h
    // expiry, but that's a non-issue for a throwaway bucket.
    await shareRow.getByLabel(/delete share record/i).click();
    await expect(
      page.getByRole("heading", { name: /remove share record/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^delete record$/i }).click();

    await expect(page.getByText(/record deleted/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(shareRow).toBeHidden({ timeout: 10_000 });
  });
});

function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function keyName(key: string): string {
  return key.split("/").pop() ?? key;
}
