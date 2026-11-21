import type { Metadata, Viewport } from "next";
import { ThemeScript } from "@ggbdpq/console-ui";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import { Providers } from "./providers";
import { GlobalSidebar } from "@/components/GlobalSidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Console · 个人 Agent 控制台",
  description: "资产 / 库存 / 注册 / 工具集 / 清单等一站式本地控制台",
};

// 浏览器 UI（地址栏/系统栏）底色随明暗联动；亮板值与 base.css 的 --background 同源暖白
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeScript />
        <div className="flex min-h-screen">
          <GlobalSidebar />
          <main className="flex-1 overflow-auto">
            <Providers>{children}</Providers>
          </main>
        </div>
      </body>
    </html>
  );
}
