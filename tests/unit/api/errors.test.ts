// tests/unit/api/errors.test.ts
//
// Spec for lib/api/errors.ts. Covers code/status mapping, response shape
// invariants ({ error: { code, message, requestId, details? } }), and
// graceful fallback for unknown throws (must collapse to 500 + internal
// code, never leak the original Error.message).

import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import {
  ApiError,
  ApiErrorCode,
  ApiErrors,
  toErrorResponse,
} from "@/lib/api/errors";

const RID = "00000000-0000-0000-0000-000000000001";

async function readBody(res: Response) {
  return (await res.json()) as {
    error: {
      code: string;
      message: string;
      requestId: string;
      details?: unknown;
    };
  };
}

describe("ApiErrors factory", () => {
  it("maps unauthorized → 401 auth.unauthorized", () => {
    const e = ApiErrors.unauthorized();
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.code).toBe(ApiErrorCode.AuthUnauthorized);
  });

  it("maps csrfInvalid → 401 csrf.invalid", () => {
    const e = ApiErrors.csrfInvalid();
    expect(e.status).toBe(401);
    expect(e.code).toBe(ApiErrorCode.CsrfInvalid);
  });

  it("maps validationInvalid → 400 validation.invalid + flattened details", () => {
    const schema = z.object({ name: z.string().min(2) });
    const parsed = schema.safeParse({ name: "" });
    if (parsed.success) throw new Error("expected failure");
    const e = ApiErrors.validationInvalid(parsed.error);
    expect(e.status).toBe(400);
    expect(e.code).toBe(ApiErrorCode.ValidationInvalid);
    expect(e.details).toBeDefined();
  });
});

describe("toErrorResponse", () => {
  it("serializes ApiError to the unified shape", async () => {
    const res = toErrorResponse(ApiErrors.notFound("Bucket missing"), RID);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe(RID);
    const body = await readBody(res);
    expect(body.error.code).toBe(ApiErrorCode.NotFound);
    expect(body.error.message).toBe("Bucket missing");
    expect(body.error.requestId).toBe(RID);
  });

  it("maps a raw ZodError through validationInvalid", async () => {
    const schema = z.object({ a: z.number() });
    const parsed = schema.safeParse({ a: "x" });
    if (parsed.success) throw new Error("expected failure");
    const res = toErrorResponse(parsed.error, RID);
    expect(res.status).toBe(400);
    const body = await readBody(res);
    expect(body.error.code).toBe(ApiErrorCode.ValidationInvalid);
    expect(body.error.details).toBeDefined();
  });

  it("collapses unknown throws to 500 internal.unexpected (no leak)", async () => {
    const res = toErrorResponse(new Error("super secret stack"), RID);
    expect(res.status).toBe(500);
    const body = await readBody(res);
    expect(body.error.code).toBe(ApiErrorCode.InternalUnexpected);
    expect(body.error.message).toBe("Unexpected server error");
    expect(body.error.message).not.toContain("super secret");
  });

  it("always includes requestId in error payloads", async () => {
    for (const err of [
      ApiErrors.unauthorized(),
      ApiErrors.csrfInvalid(),
      new Error("unknown"),
      new ZodError([]),
    ]) {
      const body = await readBody(toErrorResponse(err, RID));
      expect(body.error.requestId).toBe(RID);
    }
  });
});
