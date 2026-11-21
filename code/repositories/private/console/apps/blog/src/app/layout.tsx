import type { Metadata, Viewport } from "next";
import { ThemeScript } from "@ggbdpq/console-ui";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import { BlogSidebar } from "@/components/BlogSidebar";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

export const metadata: Metadata = {
  title: {
    default: "ggbdpq 的博客",
    template: "%s · ggbdpq 的博客",
  },
  description: "日拱一卒，功不唐捐。记录技术、阅读与成长。",
  alternates: {
    types: { "application/rss+xml": "/rss.xml" },
  },
};

// 与控制台同构的应用壳：左侧菜单 + 右侧内容。
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeScript />
        <div className="flex min-h-screen">
          <BlogSidebar />
          <main className="min-w-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-[1720px] px-6 py-8">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
