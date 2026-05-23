"use client";

const T = {
  title: "设置",
  comingSoon: "更多设置项即将上线。连接管理已迁移到左侧「连接管理」入口。",
} as const;

export default function SettingsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {T.comingSoon}
      </p>
    </div>
  );
}
