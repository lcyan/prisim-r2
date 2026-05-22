// tests/e2e/fixtures.ts
//
// Shared helpers for the authenticated specs (browse/upload/download,
// delete, share). All three flows depend on:
//
//   1. A throwaway R2 connection. We mint one per worker via the public
//      API (POST /api/connections) so the spec doesn't have to walk the
//      AddConnection dialog every run — the connections.spec.ts file
//      already covers the dialog path.
//
//   2. An "active connection" selection in the dashboard. The Zustand
//      store persists this in localStorage, so the helper stamps it
//      directly via page.evaluate(...) — both faster and less brittle
//      than driving the BucketSwitcher menu UI before every test.
//
//   3. A test bucket the connection is allowed to write to. We rely on
//      E2E_R2_BUCKET being a pre-existing, OK-to-litter bucket; creating
//      buckets from the app is intentionally not supported in V1.
//
// All env access is gated. Specs call `requireE2EEnv()` in their
// describe.skip and `setupTestConnection()` in beforeAll. Missing env
// is a skip, not a hard failure — the parent task ships with a runbook
// describing how to wire the secrets.

import {
  request,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

export interface E2EEnv {
  accountId: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/** Read and validate the R2 test env. Returns null when anything is
 *  missing so the caller can pass it directly to `test.skip(...)`. */
export function readE2EEnv(): E2EEnv | null {
  const accountId = process.env.E2E_R2_ACCOUNT_ID;
  const accessKey = process.env.E2E_R2_ACCESS_KEY;
  const secretKey = process.env.E2E_R2_SECRET_KEY;
  const bucket = process.env.E2E_R2_BUCKET;
  if (!accountId || !accessKey || !secretKey || !bucket) return null;
  return { accountId, accessKey, secretKey, bucket };
}

export const E2E_ENV_SKIP_REASON =
  "Set E2E_R2_ACCOUNT_ID / E2E_R2_ACCESS_KEY / E2E_R2_SECRET_KEY / E2E_R2_BUCKET to run object-plane E2E.";

/** Create (or reuse) an "e2e" connection through the public API and
 *  return its ID + name. We hit the API directly (rather than driving
 *  AddConnectionDialog) because:
 *   - the dialog path is already exercised in connections.spec.ts,
 *   - the dialog does a real R2 probe; doing it once per spec file is
 *     fine, doing it again here would be wasteful, and
 *   - using the API forces us through the same CSRF + cookie path the
 *     UI uses, so if that breaks we'll know.
 */
export async function ensureTestConnection({
  page,
  env,
  baseURL,
}: {
  page: Page;
  env: E2EEnv;
  baseURL: string;
}): Promise<{ id: string; name: string }> {
  // Reuse the page's storageState cookies — the page is already logged in.
  const apiContext = await request.newContext({
    baseURL,
    storageState: await page.context().storageState(),
  });

  try {
    // Look for an existing e2e-prefixed connection first.
    const existing = await listConnections(apiContext);
    const reused = existing.find((c) => c.name.startsWith("e2e-fixture"));
    if (reused) return { id: reused.id, name: reused.name };

    // Otherwise mint one. We tag the name with a worker index suffix so
    // parallel workers don't fight over a single row (in practice the
    // config pins workers=1 in CI, but be defensive).
    const name = `e2e-fixture-${process.env.TEST_WORKER_INDEX ?? "0"}`;
    const csrf = await fetchCsrfCookie(apiContext);
    const res = await apiContext.post("/api/connections", {
      headers: { "X-CSRF-Token": csrf },
      data: {
        name,
        accountId: env.accountId,
        accessKeyId: env.accessKey,
        secretAccessKey: env.secretKey,
      },
    });
    expect(
      res.ok(),
      `POST /api/connections failed: ${await res.text()}`,
    ).toBeTruthy();
    const created = (await res.json()) as { id: string; name: string };
    return { id: created.id, name: created.name };
  } finally {
    await apiContext.dispose();
  }
}

/** Mirror what the BucketSwitcher does on click — write the selection
 *  into the active-connection Zustand store via localStorage so the
 *  next navigation picks it up. Persist format must match `version: 2`
 *  in stores/active-connection.ts, otherwise hydration's `migrate`
 *  callback wipes activeBucket back to null. */
export async function setActiveConnection(
  page: Page,
  cid: string,
  bucket: string,
) {
  // Navigate to / first so the store is mounted in this origin's
  // localStorage. Without a prior visit, Chromium has no storage for
  // localhost:8788 yet.
  await page.goto("/");
  await page.evaluate(
    ([cidVal, bucketVal]) => {
      const payload = JSON.stringify({
        state: { activeConnectionId: cidVal, activeBucket: bucketVal },
        version: 2,
      });
      window.localStorage.setItem("prisim-r2:active-connection", payload);
    },
    [cid, bucket],
  );
}

/** Upload an object straight through the presigned URL flow, sidestepping
 *  the dropzone UI. Returns the key on success. Used by specs that need a
 *  fixture object present but don't want to spend ~15s driving the upload
 *  drawer for each one. */
export async function uploadObjectViaApi({
  page,
  baseURL,
  cid,
  bucket,
  key,
  body,
  contentType,
}: {
  page: Page;
  baseURL: string;
  cid: string;
  bucket: string;
  key: string;
  body: Buffer | string;
  contentType?: string;
}) {
  const apiContext = await request.newContext({
    baseURL,
    storageState: await page.context().storageState(),
  });
  try {
    const csrf = await fetchCsrfCookie(apiContext);
    const presign = await apiContext.post("/api/r2/presign", {
      headers: { "X-CSRF-Token": csrf },
      data: { cid, bucket, key, op: "put", ttl: 900 },
    });
    expect(
      presign.ok(),
      `presign failed: ${await presign.text()}`,
    ).toBeTruthy();
    const { url } = (await presign.json()) as { url: string };

    const put = await apiContext.fetch(url, {
      method: "PUT",
      headers: contentType ? { "Content-Type": contentType } : undefined,
      data: body,
    });
    expect(
      put.ok(),
      `R2 PUT for ${key} failed (HTTP ${put.status()}): ${await put.text()}`,
    ).toBeTruthy();
  } finally {
    await apiContext.dispose();
  }
}

/** Read the CSRF cookie that GET /api/csrf sets and return its raw value
 *  for use in the `X-CSRF-Token` request header. */
async function fetchCsrfCookie(api: APIRequestContext): Promise<string> {
  const res = await api.get("/api/csrf");
  expect(res.ok(), "GET /api/csrf failed").toBeTruthy();
  const cookies = await api.storageState();
  const csrf = cookies.cookies.find((c) => c.name === "csrf");
  if (!csrf) {
    throw new Error("`csrf` cookie not set after GET /api/csrf");
  }
  return csrf.value;
}

async function listConnections(
  api: APIRequestContext,
): Promise<Array<{ id: string; name: string }>> {
  const res = await api.get("/api/connections");
  expect(res.ok(), "GET /api/connections failed").toBeTruthy();
  return (await res.json()) as Array<{ id: string; name: string }>;
}

/** Build the same path-style browse href the dashboard uses. */
export function browseHref(bucket: string, prefix: string): string {
  const segments = prefix
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s));
  const head = `/buckets/${encodeURIComponent(bucket)}`;
  return segments.length === 0 ? head : `${head}/${segments.join("/")}`;
}
