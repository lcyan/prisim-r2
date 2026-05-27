// tests/unit/uploads/_fake-xhr.ts
//
// FakeXhr — a minimal XMLHttpRequest stand-in driven from tests. Replaces
// the global XMLHttpRequest in vitest (which runs in Node and has no real
// XHR). Provides hooks the test can call to simulate progress events,
// success, HTTP errors, network errors, timeouts, and aborts.
//
// Each `new XMLHttpRequest()` is recorded in a module-level registry so
// tests can interleave assertions ("at this moment, exactly 3 active") with
// driving each instance through to completion.

import { vi } from "vitest";

export type FakeXhrSent = {
  method: string;
  url: string;
  body: Blob | string | null;
  headers: Record<string, string>;
};

export class FakeXhr {
  status = 0;
  responseText = "";
  upload: {
    onprogress:
      | ((ev: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void)
      | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  private _method = "";
  private _url = "";
  private _body: Blob | string | null = null;
  private _bodySize = 0;
  private _headers: Record<string, string> = {};
  private _responseHeaders: Record<string, string> = {};
  private _settled = false;

  open(method: string, url: string): void {
    this._method = method;
    this._url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this._headers[name] = value;
  }

  send(body: Blob | string | null): void {
    this._body = body;
    if (body && typeof (body as Blob).size === "number") {
      this._bodySize = (body as Blob).size;
    } else if (typeof body === "string") {
      this._bodySize = body.length;
    }
    registry.active.push(this);
    registry.sent.push({
      method: this._method,
      url: this._url,
      body: this._body,
      headers: { ...this._headers },
    });
    registry.onSend?.(this);
  }

  abort(): void {
    if (this._settled) return;
    this._settled = true;
    this._removeFromActive();
    this.onabort?.();
  }

  getResponseHeader(name: string): string | null {
    return (
      this._responseHeaders[name] ??
      this._responseHeaders[name.toLowerCase()] ??
      null
    );
  }

  /* ──────────── test hooks ──────────── */

  fireProgress(loaded: number, total = this._bodySize): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  /** Simulate a successful 2xx with optional response headers (typically
   *  { ETag: '"abc..."' }). Defaults to 200. */
  succeed(
    opts: { status?: number; headers?: Record<string, string> } = {},
  ): void {
    if (this._settled) return;
    this._settled = true;
    this.status = opts.status ?? 200;
    this._responseHeaders = opts.headers ?? {};
    this._removeFromActive();
    this.onload?.();
  }

  /** Simulate a non-2xx response. */
  fail(status: number, body = ""): void {
    if (this._settled) return;
    this._settled = true;
    this.status = status;
    this.responseText = body;
    this._removeFromActive();
    this.onload?.();
  }

  /** Simulate xhr.onerror (DNS failure, TCP reset). */
  networkError(): void {
    if (this._settled) return;
    this._settled = true;
    this._removeFromActive();
    this.onerror?.();
  }

  /** Simulate xhr.ontimeout. */
  timeoutError(): void {
    if (this._settled) return;
    this._settled = true;
    this._removeFromActive();
    this.ontimeout?.();
  }

  url(): string {
    return this._url;
  }

  body(): Blob | string | null {
    return this._body;
  }

  bodySize(): number {
    return this._bodySize;
  }

  private _removeFromActive(): void {
    const idx = registry.active.indexOf(this);
    if (idx >= 0) registry.active.splice(idx, 1);
  }
}

interface FakeXhrRegistry {
  active: FakeXhr[];
  sent: FakeXhrSent[];
  onSend?: (xhr: FakeXhr) => void;
}

export const registry: FakeXhrRegistry = {
  active: [],
  sent: [],
};

/** Install FakeXhr as global.XMLHttpRequest for the duration of a test.
 *  Returns a tear-down function that restores the previous global. */
export function installFakeXhr(): () => void {
  const prev = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest =
    FakeXhr as unknown as typeof XMLHttpRequest;
  registry.active = [];
  registry.sent = [];
  registry.onSend = undefined;
  return () => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = prev;
    registry.active = [];
    registry.sent = [];
    registry.onSend = undefined;
  };
}

/** Build a File-like object of arbitrary `size` without allocating bytes.
 *  Returned object satisfies the structural needs of single-put.ts and
 *  multipart.ts (file.size, file.slice(start, end), file.type). */
export function fakeFile(
  name: string,
  size: number,
  type = "application/octet-stream",
): File {
  const slice = (start = 0, end = size): Blob =>
    ({
      size: Math.max(0, (end ?? size) - start),
      type: "",
    }) as Blob;
  return {
    name,
    size,
    type,
    slice,
    lastModified: 0,
    webkitRelativePath: "",
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    stream: () => undefined as never,
    text: () => Promise.resolve(""),
  } as unknown as File;
}

/** Helper to install a vi.fn() mock for apiFetch that returns a sequence of
 *  pre-built responses keyed by URL substring. Falls through with the
 *  provided default for any unmatched URL. */
export function makeApiFetchMock(
  handlers: Array<{
    matches: (
      url: string,
      init: { method?: string; json?: unknown },
    ) => boolean;
    respond: (input: {
      url: string;
      init: { method?: string; json?: unknown };
    }) => unknown | Promise<unknown>;
  }>,
) {
  return vi.fn(
    async (url: string, init: { method?: string; json?: unknown } = {}) => {
      for (const h of handlers) {
        if (h.matches(url, init)) {
          return h.respond({ url, init });
        }
      }
      throw new Error(`No mock handler for ${init.method ?? "GET"} ${url}`);
    },
  );
}
