// tests/e2e/browse-upload-download.spec.ts
//
// Full object-plane happy path: select a bucket → upload via the Dropzone's
// browse button → confirm the object lands in the listing → trigger a
// download and verify the bytes round-trip.
//
// Why this lives in E2E and not Vitest:
//   * Upload uses a real browser file-chooser + the FormData→presigned PUT
//     pipeline. We can mock pieces of that in unit tests, but only Chromium
//     exercises the full path including CORS preflight against R2.
//   * Download relies on the browser's native download manager firing a
//     `download` event. There is no equivalent in JSDOM.
//
// Cleanup discipline:
//   * Every spec uploads under a uniquely-prefixed key
//     (`e2e/<ts>-<rand>-name.ext`) so multiple runs don't fight.
//   * afterEach deletes the uploaded key via the API to keep the throwaway
//     bucket bounded. The delete spec exercises the UI delete dialog;
//     here we only need teardown, so the API path is faster + clearer.

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

test.describe("browse, upload, download", () => {
  test.skip(!env, E2E_ENV_SKIP_REASON);

  // We resolve a baseURL the same way the rest of the specs do — pull it
  // off the test fixture or fall back to the env override. The playwright
  // context's options aren't a stable public API, so we read it from the
  // project's `use.baseURL` via the public test.info() surface.
  let baseURL: string;
  let cid: string;

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!env) return; // skipped above; keep TS narrow
    baseURL =
      testInfo.project.use.baseURL ??
      process.env.E2E_BASE_URL ??
      "http://localhost:8788";
    const page = await browser.newPage();
    const created = await ensureTestConnection({ page, env, baseURL });
    cid = created.id;
    await page.close();
  });

  test("uploads a small file via the dropzone and lists it", async ({
    page,
  }) => {
    if (!env) return;
    await setActiveConnection(page, cid, env.bucket);

    const key = `e2e/${stamp()}-hello.txt`;
    const body = "hello e2e\n";

    await page.goto(browseHref(env.bucket, "e2e/"));
    await waitForFileListing(page);

    // Drive the hidden multi-file input via the file chooser. The
    // Dropzone exposes a "browse" link that triggers the input click.
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: /browse/i }).click(),
    ]);
    await chooser.setFiles({
      name: keyToFilename(key),
      mimeType: "text/plain",
      buffer: Buffer.from(body, "utf8"),
    });

    // The dispatcher fires a "queued" toast immediately and a "uploaded"
    // toast / progress completion once R2 returns 200. Wait on the
    // listing instead — it's the strongest end-to-end signal.
    await expect(
      page.getByRole("row").filter({ hasText: keyToFilename(key) }),
    ).toBeVisible({ timeout: 30_000 });

    // Cleanup so subsequent runs start clean.
    await deleteObjectViaApi(page, baseURL, cid, env.bucket, key);
  });

  test("downloads an object and matches the source bytes", async ({ page }) => {
    if (!env) return;
    await setActiveConnection(page, cid, env.bucket);

    const key = `e2e/${stamp()}-download.txt`;
    const expected = `download-roundtrip-${stamp()}\n`;

    // Pre-seed the bucket via the API so we test only the download path.
    await uploadObjectViaApi({
      page,
      baseURL,
      cid,
      bucket: env.bucket,
      key,
      body: expected,
      contentType: "text/plain",
    });

    await page.goto(browseHref(env.bucket, "e2e/"));
    const row = page
      .getByRole("row")
      .filter({ hasText: keyToFilename(key) })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Trigger download via the row's hover-revealed Download action.
    // hover first to materialise the button (`opacity-0` until hover);
    // Playwright's getByLabel still resolves it because it's in the DOM,
    // but explicit hover makes failures obvious in the trace.
    await row.hover();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      row.getByLabel(/^download$/i).click(),
    ]);

    // download.path() returns a temp path that Playwright manages; we
    // read it into a Buffer and compare bytes. Buffer equality is
    // exact — any mode/encoding drift will fail loudly.
    const tmpPath = await download.path();
    const fs = await import("node:fs/promises");
    const actual = await fs.readFile(tmpPath, "utf8");
    expect(actual).toBe(expected);

    await deleteObjectViaApi(page, baseURL, cid, env.bucket, key);
  });
});

/* ─── helpers ───────────────────────────────────────────────── */

function stamp(): string {
  // Date.now() + a 4-char random tail. The random tail prevents
  // collisions when two specs in the same describe race on file naming
  // (we run workers=1 in CI but local dev may use more).
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${t}-${r}`;
}

function keyToFilename(key: string): string {
  return key.split("/").pop() ?? key;
}

/** Wait until the file listing has resolved into either a row or the
 *  "This prefix is empty." state — both signal that useObjects() finished
 *  loading. Without this the upload's file chooser sometimes races the
 *  initial query and the queue dispatcher swallows the file. */
async function waitForFileListing(page: Page) {
  await Promise.race([
    page.getByText(/this prefix is empty\./i).waitFor({ timeout: 20_000 }),
    page.getByRole("row").first().waitFor({ timeout: 20_000 }),
  ]);
}

async function deleteObjectViaApi(
  page: Page,
  baseURL: string,
  cid: string,
  bucket: string,
  key: string,
) {
  const { request } = await import("@playwright/test");
  const api = await request.newContext({
    baseURL,
    storageState: await page.context().storageState(),
  });
  try {
    // Read the csrf cookie from the page's existing storageState; one
    // round-trip to /api/csrf is enough to (re)issue it if missing.
    await api.get("/api/csrf");
    const cookies = await api.storageState();
    const csrf = cookies.cookies.find((c) => c.name === "csrf")?.value ?? "";

    const prepare = await api.post("/api/r2/delete/prepare", {
      headers: { "X-CSRF-Token": csrf },
      data: { cid, bucket, keys: [key] },
    });
    if (!prepare.ok()) return; // best-effort cleanup
    const { confirmToken } = (await prepare.json()) as {
      confirmToken: string;
    };
    await api.post("/api/r2/delete", {
      headers: { "X-CSRF-Token": csrf },
      data: { cid, bucket, keys: [key], confirmToken },
    });
  } finally {
    await api.dispose();
  }
}
