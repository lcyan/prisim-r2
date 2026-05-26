// tests/unit/api/with-public-api.test.ts
//
// Spec for the pre-auth `withPublicApi` wrapper used by /api/auth/totp/*
// endpoints. We mount the real checkLimit UPSERT against an in-memory
// better-sqlite3 (same pattern as middleware-rate-limit.test.ts), but the
// wrapper itself has no session/CSRF to stub — the IP-keyed policy is the
// only gate before the handler runs.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { ApiErrors } from "@/lib/api/errors";
import { RateLimitPolicies } from "@/lib/api/rate-limit";
import type { RateLimitDb } from "@/lib/api/rate-limit";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../drizzle/migrations");

function applyMigrations(sqlite: InstanceType<typeof Database>) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
}

let d1Facade: RateLimitDb;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { DB: d1Facade } }),
}));

beforeEach(() => {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  d1Facade = {
    prepare(q: string) {
      const stmt = sqlite.prepare(q);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              return (stmt.get(...args) as T) ?? null;
            },
          };
        },
      };
    },
  };
});

async function importWrapper() {
  const mod = await import("@/lib/api/middleware");
  return mod.withPublicApi;
}

describe("withPublicApi", () => {
  it("runs handler, auto-wraps return value", async () => {
    const withPublicApi = await importWrapper();
    const route = withPublicApi(async () => ({ ok: true }));
    const res = await route(
      new Request("https://x/api/test", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps ApiError to structured response", async () => {
    const withPublicApi = await importWrapper();
    const route = withPublicApi(async () => {
      throw ApiErrors.invalidCredentials();
    });
    const res = await route(new Request("https://x/api/test", { method: "POST" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.invalid_credentials");
  });

  it("rate-limits by IP policy resolver", async () => {
    const withPublicApi = await importWrapper();
    const route = withPublicApi(
      async () => ({ ok: true }),
      {
        rateLimit: ({ ip }) => [RateLimitPolicies.totpPreflightByIp(ip)],
      },
    );
    const headers = { "cf-connecting-ip": "1.2.3.4" };
    // policy limit is 10/5min — 11th call should fail
    for (let i = 0; i < 10; i++) {
      const r = await route(
        new Request("https://x/api/test", { method: "POST", headers }),
      );
      expect(r.status).toBe(200);
    }
    const r11 = await route(
      new Request("https://x/api/test", { method: "POST", headers }),
    );
    expect(r11.status).toBe(429);
  });
});
