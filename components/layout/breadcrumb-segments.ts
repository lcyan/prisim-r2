// components/layout/breadcrumb-segments.ts
//
// 纯函数:把 next/navigation 的 pathname 映射为顶栏面包屑要渲染的段。
// 每一段是一个 discriminated union 节点,Topbar 组件按 kind 切渲染。
//
// 与 next/navigation 解耦 → 易测、易演进。

export type Segment =
  | { kind: "connection" }
  | { kind: "bucket"; name: string; href: string }
  | {
      kind: "prefix";
      label: string;
      path: string;
      href: string;
      current: boolean;
    }
  | { kind: "static"; label: string };

const SCOPED_ROUTES: Array<{ prefix: string; label: string }> = [
  { prefix: "/dashboard", label: "仪表盘" },
  { prefix: "/shares", label: "分享链接" },
  { prefix: "/audit", label: "审计日志" },
];

function browseHref(bucket: string, prefixSegments: string[] = []) {
  const encodedBucket = encodeURIComponent(bucket);
  const encodedPrefix = prefixSegments.map(encodeURIComponent).join("/");
  return encodedPrefix.length > 0
    ? `/buckets/${encodedBucket}/${encodedPrefix}`
    : `/buckets/${encodedBucket}`;
}

function prefixPath(segments: string[]) {
  return `${segments.join("/")}/`;
}

export function resolveSegments(pathname: string): Segment[] {
  // 顺序敏感:/settings/connections 必须在 /settings 与 /connections 之前判断
  if (
    pathname === "/settings/connections" ||
    pathname.startsWith("/settings/connections/")
  ) {
    return [
      { kind: "static", label: "设置" },
      { kind: "static", label: "连接管理" },
    ];
  }
  if (pathname === "/connections" || pathname.startsWith("/connections/")) {
    return [{ kind: "static", label: "连接管理" }];
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return [{ kind: "static", label: "设置" }];
  }

  // /buckets[/[bucket][/[...prefix]]]
  if (pathname === "/buckets" || pathname.startsWith("/buckets/")) {
    const segs: Segment[] = [
      { kind: "connection" },
      { kind: "static", label: "存储桶" },
    ];
    const rest = pathname.slice("/buckets".length);
    if (rest.length === 0 || rest === "/") return segs;

    const parts = rest.replace(/^\//, "").split("/");
    const bucketPart = parts[0];
    if (!bucketPart) return segs;

    const bucket = decodeURIComponent(bucketPart);
    segs.push({ kind: "bucket", name: bucket, href: browseHref(bucket) });

    const prefixSegments = parts
      .slice(1)
      .filter((p) => p.length > 0)
      .map(decodeURIComponent);

    prefixSegments.forEach((label, idx) => {
      const pathSegments = prefixSegments.slice(0, idx + 1);
      segs.push({
        kind: "prefix",
        label,
        path: prefixPath(pathSegments),
        href: browseHref(bucket, pathSegments),
        current: idx === prefixSegments.length - 1,
      });
    });

    return segs;
  }

  for (const route of SCOPED_ROUTES) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) {
      return [{ kind: "connection" }, { kind: "static", label: route.label }];
    }
  }
  return [];
}
