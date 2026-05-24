"use client";

import Link from "next/link";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const T = {
  title: "设置",
  tabConnections: "连接管理",
  tabProfile: "个人偏好",
  tabAbout: "关于",
  manageHint: "管理 R2 连接,加密凭据存储与轮换。",
  manageCta: "去连接管理",
  v2Coming: "敬请期待",
  v2Desc: "此分区将在 V2 上线。",
} as const;

export default function SettingsPage() {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{T.title}</h1>
      </header>
      <Tabs defaultValue="connections" className="flex-1">
        <TabsList>
          <TabsTrigger value="connections">{T.tabConnections}</TabsTrigger>
          <TabsTrigger value="profile">{T.tabProfile}</TabsTrigger>
          <TabsTrigger value="about">{T.tabAbout}</TabsTrigger>
        </TabsList>
        <TabsContent value="connections" className="mt-4">
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">{T.manageHint}</p>
            <Link
              href="/connections"
              className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {T.manageCta}
            </Link>
          </div>
        </TabsContent>
        <TabsContent value="profile" className="mt-4">
          <V2Placeholder />
        </TabsContent>
        <TabsContent value="about" className="mt-4">
          <V2Placeholder />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function V2Placeholder() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
      <p className="font-display text-lg italic text-muted-foreground">
        {T.v2Coming}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{T.v2Desc}</p>
    </div>
  );
}
