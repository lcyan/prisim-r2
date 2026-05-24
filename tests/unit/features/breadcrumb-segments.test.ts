import { describe, it, expect } from "vitest";
import { resolveSegments } from "@/components/layout/breadcrumb-segments";

describe("resolveSegments — connection-scoped routes", () => {
  it("/dashboard → conn + 仪表盘", () => {
    expect(resolveSegments("/dashboard")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "仪表盘" },
    ]);
  });

  it("/buckets → conn + 存储桶", () => {
    expect(resolveSegments("/buckets")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
    ]);
  });

  it("/buckets/my-bucket → conn + 存储桶 + bucket(my-bucket)", () => {
    expect(resolveSegments("/buckets/my-bucket")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
      { kind: "bucket", name: "my-bucket" },
    ]);
  });

  it("/buckets/my-bucket/foo/bar → conn + 存储桶 + bucket + prefix", () => {
    expect(resolveSegments("/buckets/my-bucket/foo/bar")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
      { kind: "bucket", name: "my-bucket" },
      { kind: "prefix", path: "foo/bar/" },
    ]);
  });

  it("/buckets/my-bucket/foo/ trailing slash normalizes", () => {
    expect(resolveSegments("/buckets/my-bucket/foo/")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
      { kind: "bucket", name: "my-bucket" },
      { kind: "prefix", path: "foo/" },
    ]);
  });

  it("/shares → conn + 分享链接", () => {
    expect(resolveSegments("/shares")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "分享链接" },
    ]);
  });

  it("/audit → conn + 审计日志", () => {
    expect(resolveSegments("/audit")).toEqual([
      { kind: "connection" },
      { kind: "static", label: "审计日志" },
    ]);
  });
});

describe("resolveSegments — global routes (no conn segment)", () => {
  it("/connections → 连接管理 only", () => {
    expect(resolveSegments("/connections")).toEqual([
      { kind: "static", label: "连接管理" },
    ]);
  });

  it("/settings → 设置 only", () => {
    expect(resolveSegments("/settings")).toEqual([
      { kind: "static", label: "设置" },
    ]);
  });

  it("/settings/connections → 设置 + 连接管理", () => {
    expect(resolveSegments("/settings/connections")).toEqual([
      { kind: "static", label: "设置" },
      { kind: "static", label: "连接管理" },
    ]);
  });
});

describe("resolveSegments — fallback", () => {
  it("unknown route → empty array", () => {
    expect(resolveSegments("/nope/123")).toEqual([]);
  });
});
