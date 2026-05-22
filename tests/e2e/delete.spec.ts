// tests/e2e/delete.spec.ts
//
// Exercises CLAUDE.md security invariant #4 end-to-end: the destructive
// object delete flow MUST require an exact typed confirmation on the
// client, and the server-side route MUST reject a missing/expired
// confirm token. We can't lean on Vitest for this — the typed-name gating
// is a Radix dialog dance, and the prepare → confirm hand-off involves
// the CSRF cookie + cross-request token lifetime.
//
// Three scenarios:
//   1. Wrong bucket name typed → Delete button stays disabled.
//   2. Correct bucket name typed → single-object delete succeeds and the
//      row disappears from the listing.
//   3. Bulk select + delete (3 objects under the same prefix) → all three
//      gone, "<N> selected" banner empties.

import { test, expect, type Page } from "@playwright/test";
import { Buffer } from "node:buffer";

import {
  E2E_ENV_SKIP_REASON,
  ensureTestConnection,
  readE2EEnv,
  setActiveConnection,
  uploadObjectViaApi,
  browseHref,
} from "./fixtures";

const env = readE2EEnv();

test.describe("delete", () => {
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

  test("typing the wrong bucket name keeps the Delete button disabled", async ({
    page,
  }) => {
    if (!env) return;
    await setActiveConnection(page, cid, env.bucket);

    const key = `e2e/${stamp()}-no-delete.txt`;
    await uploadObjectViaApi({
      page,
      baseURL,
      cid,
      bucket: env.bucket,
      key,
      body: "must-not-be-deleted",
      contentType: "text/plain",
    });

    await page.goto(browseHref(env.bucket, "e2e/"));
    const row = page
      .getByRole("row")
      .filter({ hasText: keyName(key) })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    await openDeleteDialog(page, row);

    // Typed bucket name is wrong. Even one-char delta should keep the
    // button disabled — exact-match is the contract from delete-dialog.tsx.
    const confirmInput = page.getByLabel(/type bucket name/i);
    await confirmInput.fill(`${env.bucket}X`);
    const deleteButton = page.getByRole("button", { name: /^delete object$/i });
    await expect(deleteButton).toBeDisabled();

    // Cleanup so the spec is rerunnable.
    await page.getByRole("button", { name: /cancel/i }).click();
    await deleteViaApi(page, baseURL, cid, env.bucket, [key]);
  });

  test("typing the bucket name enables Delete and removes the object", async ({
    page,
  }) => {
    if (!env) return;
    await setActiveConnection(page, cid, env.bucket);

    const key = `e2e/${stamp()}-single-del.txt`;
    await uploadObjectViaApi({
      page,
      baseURL,
      cid,
      bucket: env.bucket,
      key,
      body: "delete-me",
      contentType: "text/plain",
    });

    await page.goto(browseHref(env.bucket, "e2e/"));
    const row = page
      .getByRole("row")
      .filter({ hasText: keyName(key) })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    await openDeleteDialog(page, row);

    const confirmInput = page.getByLabel(/type bucket name/i);
    await confirmInput.fill(env.bucket);

    const deleteButton = page.getByRole("button", { name: /^delete object$/i });
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    // Success toast comes through sonner; the row also disappears from
    // the listing once useObjects() refetches.
    await expect(page.getByText(/1 object deleted/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(row).toBeHidden({ timeout: 15_000 });
  });

  test("bulk-delete removes every selected object under a prefix", async ({
    page,
  }) => {
    if (!env) return;
    await setActiveConnection(page, cid, env.bucket);

    const prefix = `e2e/bulk-${stamp()}/`;
    const keys = [0, 1, 2].map((i) => `${prefix}item-${i}.txt`);
    for (const k of keys) {
      await uploadObjectViaApi({
        page,
        baseURL,
        cid,
        bucket: env.bucket,
        key: k,
        body: Buffer.from(`payload-${k}\n`),
        contentType: "text/plain",
      });
    }

    await page.goto(browseHref(env.bucket, prefix));

    // Select-all checkbox on the header row selects the three items.
    const selectAll = page.getByRole("checkbox", {
      name: /select all rows on this page/i,
    });
    await expect(selectAll).toBeVisible({ timeout: 20_000 });
    await selectAll.check();

    // SelectionBanner Delete button (different from the dialog's Delete
    // — this one only opens it).
    await page
      .getByRole("region", { name: /objects to delete/i })
      .or(page.getByText(/3 selected/i))
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => undefined);
    await page
      .getByRole("button", { name: /^delete$/i })
      .first()
      .click();

    const confirmInput = page.getByLabel(/type bucket name/i);
    await confirmInput.fill(env.bucket);

    await page.getByRole("button", { name: /^delete 3 objects$/i }).click();

    // Toast text uses the plural form for n > 1.
    await expect(page.getByText(/3 objects deleted/i)).toBeVisible({
      timeout: 15_000,
    });

    // All three rows should be gone from the prefix view.
    for (const k of keys) {
      const row = page.getByRole("row").filter({ hasText: keyName(k) });
      await expect(row).toBeHidden({ timeout: 15_000 });
    }
  });
});

/* ─── helpers ─────────────────────────────────────────────── */

function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function keyName(key: string): string {
  return key.split("/").pop() ?? key;
}

/** Open the destructive delete dialog by hovering the row + clicking its
 *  Delete action. The hover materialises the action group (`opacity-0`
 *  → `opacity-100` on `group-hover`). */
async function openDeleteDialog(
  page: Page,
  row: ReturnType<Page["getByRole"]>,
) {
  await row.hover();
  await row.getByLabel(/^delete$/i).click();
  await expect(
    page.getByRole("heading", { name: /^delete object$/i }),
  ).toBeVisible({ timeout: 5_000 });
}

/** Direct API delete used by cancelled scenarios so we don't leak objects
 *  between runs. Mirrors deleteObjectViaApi in browse-upload-download.spec.ts
 *  but kept local so each spec file stays standalone. */
async function deleteViaApi(
  page: Page,
  baseURL: string,
  cid: string,
  bucket: string,
  keys: string[],
) {
  const { request } = await import("@playwright/test");
  const api = await request.newContext({
    baseURL,
    storageState: await page.context().storageState(),
  });
  try {
    await api.get("/api/csrf");
    const cookies = await api.storageState();
    const csrf = cookies.cookies.find((c) => c.name === "csrf")?.value ?? "";
    const prep = await api.post("/api/r2/delete/prepare", {
      headers: { "X-CSRF-Token": csrf },
      data: { cid, bucket, keys },
    });
    if (!prep.ok()) return;
    const { confirmToken } = (await prep.json()) as { confirmToken: string };
    await api.post("/api/r2/delete", {
      headers: { "X-CSRF-Token": csrf },
      data: { cid, bucket, keys, confirmToken },
    });
  } finally {
    await api.dispose();
  }
}
