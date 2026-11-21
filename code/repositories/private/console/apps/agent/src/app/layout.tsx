import type { Metadata, Viewport } from "next";
import { ThemeScript } from "@ggbdpq/console-ui";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import { Providers } from "./providers";
import { AgentSidebar } from "@/components/AgentSidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent · AI Agent 一站式工作台",
  description: "配置台 / 治理台 / 实验室 / 执行引擎 / Worktree 台 / 技能管理 / 课程 / 幻灯片 —— AI Agent 一站式",
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
          <AgentSidebar />
          <main className="flex-1 overflow-auto">
            <Providers>{children}</Providers>
          </main>
        </div>
      </body>
    </html>
  );
}
