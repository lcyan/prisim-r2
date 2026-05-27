import { describe, it, expect } from "vitest";
import {
  R2MkdirSchema,
  ObjectKeySchema,
  AUDIT_OP_VALUES,
} from "@/lib/api/schemas";

const VALID_CID = "01H6Z0K5XJX3J6X9F6X8MZBKVQ"; // 26-char ULID
const VALID_BUCKET = "my-bucket";

describe("R2MkdirSchema", () => {
  it("accepts simple case", () => {
    const result = R2MkdirSchema.parse({
      cid: VALID_CID,
      bucket: VALID_BUCKET,
      parentPrefix: "",
      name: "logs",
    });
    expect(result.name).toBe("logs");
  });

  it("accepts nested parentPrefix ending with slash", () => {
    R2MkdirSchema.parse({
      cid: VALID_CID,
      bucket: VALID_BUCKET,
      parentPrefix: "logs/2025/",
      name: "q1",
    });
  });

  it("rejects parentPrefix not ending with slash", () => {
    expect(() =>
      R2MkdirSchema.parse({
        cid: VALID_CID,
        bucket: VALID_BUCKET,
        parentPrefix: "logs",
        name: "q1",
      }),
    ).toThrow();
  });

  it("rejects parentPrefix starting with slash", () => {
    expect(() =>
      R2MkdirSchema.parse({
        cid: VALID_CID,
        bucket: VALID_BUCKET,
        parentPrefix: "/logs/",
        name: "q1",
      }),
    ).toThrow();
  });

  it("rejects name containing slash", () => {
    expect(() =>
      R2MkdirSchema.parse({
        cid: VALID_CID,
        bucket: VALID_BUCKET,
        parentPrefix: "",
        name: "a/b",
      }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() =>
      R2MkdirSchema.parse({
        cid: VALID_CID,
        bucket: VALID_BUCKET,
        parentPrefix: "",
        name: "",
      }),
    ).toThrow();
  });

  it("rejects name with control char", () => {
    expect(() =>
      R2MkdirSchema.parse({
        cid: VALID_CID,
        bucket: VALID_BUCKET,
        parentPrefix: "",
        name: "foobar",
      }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      R2MkdirSchema.parse({
        cid: VALID_CID,
        bucket: VALID_BUCKET,
        parentPrefix: "",
        name: "logs",
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("ObjectKeySchema (relaxed)", () => {
  it("accepts a key ending in single slash (folder placeholder)", () => {
    expect(() => ObjectKeySchema.parse("logs/")).not.toThrow();
    expect(() => ObjectKeySchema.parse("logs/2025/")).not.toThrow();
  });

  it("still rejects leading slash", () => {
    expect(() => ObjectKeySchema.parse("/foo")).toThrow();
  });

  it("rejects bare slash", () => {
    expect(() => ObjectKeySchema.parse("/")).toThrow();
  });

  it("rejects double slash", () => {
    expect(() => ObjectKeySchema.parse("a//b")).toThrow();
  });
});

describe("AUDIT_OP_VALUES", () => {
  it("includes r2.mkdir", () => {
    expect(AUDIT_OP_VALUES).toContain("r2.mkdir");
  });
});
