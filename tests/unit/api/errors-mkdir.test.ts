import { describe, it, expect } from "vitest";
import { ApiErrors, ApiError } from "@/lib/api/errors";

describe("ApiErrors.r2FolderInvalidName", () => {
  it("returns 400 with the right code + message reason", () => {
    const err = ApiErrors.r2FolderInvalidName("名称不能为空");
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("r2.folder_invalid_name");
    expect(err.status).toBe(400);
    expect(err.message).toContain("名称不能为空");
  });
});

describe("ApiErrors.r2FolderTooDeep", () => {
  it("returns 400 with the right code", () => {
    const err = ApiErrors.r2FolderTooDeep();
    expect(err.code).toBe("r2.folder_too_deep");
    expect(err.status).toBe(400);
  });
});
