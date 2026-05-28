import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";

import { Providers } from "@/components/providers";
import "./globals.css";

// Geist + Geist Mono. Latin coverage only — CJK falls through to the
// PingFang / Microsoft YaHei stack declared in globals.css under
// `--font-sans` / `--font-mono`. `next/font` self-hosts both files at
// build time, so there's no runtime request to fonts.googleapis.com and
// the Worker bundle stays self-contained.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans-latin",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono-latin",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Prisim R2",
  description: "Cloudflare R2 存储桶管理控制台",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
