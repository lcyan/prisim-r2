import { describe, it, expect } from "vitest";
import { validateFolderName, FolderNameError } from "@/lib/r2/folder-name";

describe("validateFolderName", () => {
  it("accepts simple ascii name", () => {
    expect(validateFolderName("logs")).toEqual({ ok: true, name: "logs" });
  });

  it("accepts unicode and spaces between", () => {
    expect(validateFolderName("测试 中文")).toEqual({
      ok: true,
      name: "测试 中文",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(validateFolderName("  foo  ")).toEqual({ ok: true, name: "foo" });
  });

  it("nfc-normalizes unicode", () => {
    // Combining acute (U+0301) form → composed form
    const decomposed = "café";
    const result = validateFolderName(decomposed);
    expect(result).toEqual({ ok: true, name: "café" });
  });

  it.each(["", "  ", "\t", "\n"])("rejects empty/whitespace-only %j", (input) => {
    expect(validateFolderName(input)).toEqual({
      ok: false,
      reason: FolderNameError.Empty,
    });
  });

  it.each([".", ".."])("rejects dot/double-dot %j", (input) => {
    expect(validateFolderName(input)).toEqual({
      ok: false,
      reason: FolderNameError.DotName,
    });
  });

  it("rejects names containing a slash", () => {
    expect(validateFolderName("a/b")).toEqual({
      ok: false,
      reason: FolderNameError.ContainsSlash,
    });
  });

  it.each(["foo\x00bar", "x\x1fy", "tab\there"])(
    "rejects control characters %j",
    (input) => {
      expect(validateFolderName(input)).toEqual({
        ok: false,
        reason: FolderNameError.ControlChar,
      });
    },
  );

  it("rejects name longer than 255 utf-8 bytes", () => {
    const long = "x".repeat(256);
    expect(validateFolderName(long)).toEqual({
      ok: false,
      reason: FolderNameError.TooLong,
    });
  });

  it("counts utf-8 bytes for length, not js characters", () => {
    // 中 == 3 bytes utf-8. 85 chars * 3 = 255 bytes (OK), 86 chars = 258 bytes (REJECT).
    expect(validateFolderName("中".repeat(85))).toMatchObject({ ok: true });
    expect(validateFolderName("中".repeat(86))).toEqual({
      ok: false,
      reason: FolderNameError.TooLong,
    });
  });

  it.each(["CON", "prn", "Aux", "NUL", "COM1", "lpt9"])(
    "rejects windows reserved name %j (case-insensitive)",
    (input) => {
      expect(validateFolderName(input)).toEqual({
        ok: false,
        reason: FolderNameError.WindowsReserved,
      });
    },
  );

  it("allows CON.txt — only the bare reserved name is rejected", () => {
    expect(validateFolderName("CON.txt")).toEqual({
      ok: true,
      name: "CON.txt",
    });
  });
});
