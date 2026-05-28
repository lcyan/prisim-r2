"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const T = {
  eyebrow: "账户",
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
    <div className="flex h-full flex-col gap-5 px-6 py-8">
      <header>
        <p className="text-[11px] font-medium uppercase tracking-eyebrow text-muted-foreground">
          {T.eyebrow}
        </p>
        <h1 className="text-display mt-1 text-2xl font-semibold tracking-tight">
          {T.title}
        </h1>
      </header>
      <Tabs defaultValue="connections" className="flex-1">
        <TabsList>
          <TabsTrigger value="connections">{T.tabConnections}</TabsTrigger>
          <TabsTrigger value="profile">{T.tabProfile}</TabsTrigger>
          <TabsTrigger value="about">{T.tabAbout}</TabsTrigger>
        </TabsList>
        <TabsContent value="connections" className="mt-4">
          <div className="rounded-lg border border-border bg-card p-6 shadow-xs">
            <p className="text-sm text-muted-foreground">{T.manageHint}</p>
            <Button asChild className="mt-4">
              <Link href="/connections">{T.manageCta}</Link>
            </Button>
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
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center">
      <p className="text-display text-base font-medium text-foreground">
        {T.v2Coming}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{T.v2Desc}</p>
    </div>
  );
}
