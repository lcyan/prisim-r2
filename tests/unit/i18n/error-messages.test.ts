import { describe, expect, it } from "vitest";

import {
  describeError,
  ERROR_MESSAGES,
} from "@/lib/i18n/error-messages";

describe("describeError", () => {
  it("returns mapped Chinese text for known codes", () => {
    expect(describeError("auth.invalid_credentials")).toBe("邮箱或密码错误");
    expect(describeError("rate_limited")).toBe("操作过于频繁，请稍后再试");
    expect(describeError("csrf.invalid")).toBe("会话已过期，请刷新页面");
  });

  it("falls back to '操作失败（<code>）' for unknown codes", () => {
    expect(describeError("totally.fake.code")).toBe("操作失败（totally.fake.code）");
  });

  it("returns '未知错误' for null/undefined/empty", () => {
    expect(describeError(null)).toBe("未知错误");
    expect(describeError(undefined)).toBe("未知错误");
    expect(describeError("")).toBe("未知错误");
  });

  it("covers the V1 error codes used by the codebase", () => {
    const required = [
      // 后端 ApiErrorCode
      "auth.unauthorized",
      "auth.forbidden",
      "csrf.invalid",
      "validation.invalid",
      "resource.not_found",
      "resource.conflict",
      "confirmation.required",
      "rate_limited",
      "connection.invalid_credentials",
      "connection.in_use",
      "internal.unexpected",
      // 前端自定义
      "auth.invalid_credentials",
      "auth.upstream_error",
    ];
    for (const code of required) {
      expect(ERROR_MESSAGES[code]).toBeDefined();
    }
  });
});
