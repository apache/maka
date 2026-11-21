import type { Metadata, Viewport } from "next";
import { ThemeScript, ThemeToggle } from "@ggbdpq/console-ui";
import "@fontsource-variable/geist";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

export const metadata: Metadata = {
  title: "Hub · 应用门户",
  description: "个人三应用入口：控制台 / 博客 / 工具箱",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeScript />
        {/* 顶部细导航条（苹果 global-nav 的主题化变体）：品牌 + 主题切换 */}
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-12 max-w-[1440px] items-center justify-between px-6">
            <span className="text-sm font-semibold tracking-tight">
              ggbdpq Hub
            </span>
            <ThemeToggle />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
