// lib/api/client.ts
//
// Tiny browser-side fetch wrapper that:
//   1) Reads the `csrf` cookie set by GET /api/csrf
//   2) Injects it into X-CSRF-Token for any POST/PATCH/PUT/DELETE
//   3) Parses the unified { error: { code, message, requestId } } shape
//      so callers throw a typed ApiClientError instead of an opaque Response
//
// All TanStack Query mutation hooks should use `apiFetch` instead of raw
// `fetch` — that's how we keep CSRF + error handling consistent across the
// dashboard.
//
// This file is browser-only — never imported by route handlers.

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@/lib/auth/csrf-constants";
import type { ApiErrorCode, ApiErrorPayload } from "./errors";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Thrown by `apiFetch` when the server returns the unified error shape.
 * Components / hooks should `catch (err)` and switch on `err.code` rather
 * than the HTTP status. `requestId` is shown to the user for support. */
export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly requestId: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Read a cookie value from `document.cookie`. Returns null if not present.
 * Exported so the auth bootstrap effect can check whether to call /api/csrf. */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  // Decode is intentional — the cookie value is base64url, no encoding needed,
  // but we still strip any whitespace introduced by the browser.
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** Convenience accessor matching the cookie name we use for CSRF. */
export function readCsrfCookie(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}

/** One-shot bootstrap: ensure the csrf cookie exists by hitting /api/csrf.
 * Safe to call multiple times — the server is idempotent. */
export async function ensureCsrfToken(): Promise<string> {
  const existing = readCsrfCookie();
  if (existing) return existing;
  return refreshCsrfToken();
}

/** Force-fetch a fresh CSRF token, ignoring any existing cookie. Used by
 * `apiFetch`'s csrf.invalid retry path: a re-login mints a new server-side
 * hash, but the browser may still hold the previous session's `csrf=`
 * cookie until something explicitly rotates it. */
export async function refreshCsrfToken(): Promise<string> {
  const res = await fetch("/api/csrf", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh CSRF token: ${res.status}`);
  }
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  /** Object → JSON.stringify automatically; string/FormData/etc passed through. */
  json?: unknown;
  /** Pre-serialized request body (string, FormData, Blob, …). Mutually
   * exclusive with `json` — pass one or the other. */
  body?: BodyInit | null;
}

/**
 * Wrapper around `fetch` that handles CSRF and unified error parsing.
 * Returns the parsed JSON body on 2xx; throws ApiClientError on 4xx/5xx
 * when the server speaks our error envelope, or a plain Error otherwise.
 *
 * Auto-retry on `csrf.invalid`: a stale `csrf=` cookie (e.g. one that
 * survived a re-login) makes the server reject the X-CSRF-Token header.
 * We force-refresh the cookie via GET /api/csrf and retry once. If the
 * retry still fails — typical when the JWT itself has expired — the
 * second error bubbles so the user is prompted to sign in again.
 */
export async function apiFetch<T = unknown>(
  input: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const isMutation = MUTATING_METHODS.has(method);
  const csrfToken = isMutation
    ? (readCsrfCookie() ?? (await ensureCsrfToken()))
    : null;

  try {
    return await performFetch<T>(input, init, method, csrfToken);
  } catch (err) {
    if (
      isMutation &&
      err instanceof ApiClientError &&
      err.code === "csrf.invalid"
    ) {
      const fresh = await refreshCsrfToken();
      return await performFetch<T>(input, init, method, fresh);
    }
    throw err;
  }
}

async function performFetch<T>(
  input: string,
  init: ApiFetchInit,
  method: string,
  csrfToken: string | null,
): Promise<T> {
  const headers = new Headers(init.headers);

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (csrfToken) {
    headers.set(CSRF_HEADER_NAME, csrfToken);
  }

  const res = await fetch(input, {
    ...init,
    method,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? undefined),
    credentials: init.credentials ?? "include",
  });

  // 204 No Content — many DELETEs return this; treat as a successful void.
  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    if (isJson) {
      const payload = (await res.json()) as ApiErrorPayload;
      const requestId = res.headers.get("x-request-id") ?? payload.error?.requestId ?? "unknown";
      throw new ApiClientError(
        payload.error.code,
        payload.error.message,
        res.status,
        requestId,
        payload.error.details,
      );
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  return (isJson ? await res.json() : ((await res.text()) as unknown)) as T;
}
