// tests/unit/r2/errors.test.ts
//
// Spec for lib/r2/errors.ts. Verifies:
//   - the two concrete classes carry the fields the route layer relies on
//     (code, httpStatus, stable name)
//   - mapR2Error classifies AWS-flavored credential failures the SAME way
//     regardless of which field the SDK populated (.name / .Code / .code)
//   - mapR2Error is idempotent — passing an already-mapped instance
//     returns it unchanged so wrappers can chain without losing context
//   - mapR2Error never leaks raw upstream `.message` text on the wrapper
//     (PII / internal-URL hygiene; see CLAUDE.md security invariants)
//   - non-object throws (primitives, null) don't crash the mapper

import { describe, expect, it } from "vitest";
import {
  R2CredentialError,
  R2UpstreamError,
  mapR2Error,
} from "@/lib/r2/errors";

describe("R2CredentialError", () => {
  it("is an Error with a stable name + non-empty default message", () => {
    const e = new R2CredentialError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("R2CredentialError");
    expect(e.message.length).toBeGreaterThan(0);
  });

  it("accepts a custom message", () => {
    const e = new R2CredentialError("custom");
    expect(e.message).toBe("custom");
  });
});

describe("R2UpstreamError", () => {
  it("carries code + httpStatus + cause for diagnostics", () => {
    const cause = new Error("orig");
    const e = new R2UpstreamError("boom", {
      code: "InternalError",
      httpStatus: 500,
      cause,
    });
    expect(e.name).toBe("R2UpstreamError");
    expect(e.code).toBe("InternalError");
    expect(e.httpStatus).toBe(500);
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });

  it("omits code/httpStatus when not provided (undefined, not null)", () => {
    const e = new R2UpstreamError("boom");
    expect(e.code).toBeUndefined();
    expect(e.httpStatus).toBeUndefined();
  });
});

describe("mapR2Error: credential classification", () => {
  it.each([
    "InvalidAccessKeyId",
    "SignatureDoesNotMatch",
    "AccessDenied",
    "Unauthorized",
  ])("maps modern SDK .name=%s to R2CredentialError", (name) => {
    const err = Object.assign(new Error("upstream said no"), { name });
    expect(mapR2Error(err)).toBeInstanceOf(R2CredentialError);
  });

  it("maps legacy XML envelope { Code: 'InvalidAccessKeyId' } to R2CredentialError", () => {
    expect(mapR2Error({ Code: "InvalidAccessKeyId" })).toBeInstanceOf(
      R2CredentialError,
    );
  });

  it("maps transport-level { code: 'AccessDenied' } to R2CredentialError", () => {
    expect(mapR2Error({ code: "AccessDenied" })).toBeInstanceOf(
      R2CredentialError,
    );
  });

  it("prefers .name over .Code when both are present", () => {
    // .name says it's a generic InternalError, .Code says creds — modern
    // SDK path wins and this stays an upstream error, not a creds error.
    const err = { name: "InternalError", Code: "InvalidAccessKeyId" };
    expect(mapR2Error(err)).toBeInstanceOf(R2UpstreamError);
  });
});

describe("mapR2Error: upstream classification", () => {
  it("preserves upstream code + httpStatus on the wrapper", () => {
    const err = {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    };
    const mapped = mapR2Error(err);
    expect(mapped).toBeInstanceOf(R2UpstreamError);
    expect((mapped as R2UpstreamError).code).toBe("InternalError");
    expect((mapped as R2UpstreamError).httpStatus).toBe(500);
  });

  it("attaches the original error on `cause` for server-side diagnostics", () => {
    const err = { name: "SlowDown", $metadata: { httpStatusCode: 503 } };
    const mapped = mapR2Error(err) as R2UpstreamError;
    expect((mapped as { cause?: unknown }).cause).toBe(err);
  });

  it("works without $metadata (httpStatus is undefined, not an error)", () => {
    const mapped = mapR2Error({ name: "NoSuchBucket" }) as R2UpstreamError;
    expect(mapped.code).toBe("NoSuchBucket");
    expect(mapped.httpStatus).toBeUndefined();
  });
});

describe("mapR2Error: idempotency", () => {
  it("returns an existing R2CredentialError instance by reference", () => {
    const original = new R2CredentialError("pre-mapped");
    expect(mapR2Error(original)).toBe(original);
  });

  it("returns an existing R2UpstreamError instance by reference", () => {
    const original = new R2UpstreamError("pre-mapped", { code: "X" });
    expect(mapR2Error(original)).toBe(original);
  });
});

describe("mapR2Error: hardening", () => {
  it("never forwards raw upstream .message as the wrapper message", () => {
    // SDK messages can include internal paths / account-scoped URLs.
    // Routing them straight onto the wrapper would leak through any
    // .toString() call that touches the wrapper later.
    const err = {
      name: "InternalError",
      message: "s3://internal-bucket/secret-path",
    };
    const mapped = mapR2Error(err) as R2UpstreamError;
    expect(mapped.message).not.toContain("s3://internal-bucket/secret-path");
  });

  it("handles null without throwing", () => {
    expect(mapR2Error(null)).toBeInstanceOf(R2UpstreamError);
  });

  it("handles string throws without throwing", () => {
    const mapped = mapR2Error("just a string");
    expect(mapped).toBeInstanceOf(R2UpstreamError);
    expect((mapped as { cause?: unknown }).cause).toBe("just a string");
  });

  it("handles plain objects with no recognizable fields", () => {
    const mapped = mapR2Error({}) as R2UpstreamError;
    expect(mapped).toBeInstanceOf(R2UpstreamError);
    expect(mapped.code).toBeUndefined();
    expect(mapped.httpStatus).toBeUndefined();
  });
});
