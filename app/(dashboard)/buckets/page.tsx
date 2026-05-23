"use client";

const T = {
  title: "存储桶",
  hint: "从顶栏切换 Bucket 或在左侧选择一个 Bucket 开始浏览。",
} as const;

export default function BucketsIndexPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {T.hint}
      </p>
    </div>
  );
}
