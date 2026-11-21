import type { Metadata, Viewport } from "next";
import { ThemeScript } from "@ggbdpq/console-ui";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
// 工具箱应用壳：与控制台同构（左侧菜单 + 右侧内容）
import { ToolboxSidebar } from "@/components/ToolboxSidebar";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

export const metadata: Metadata = {
  title: "工具箱 · 演示与本地工具",
  description: "产品演示模块与本地小工具：论坛/后台/简历/约会攻略/聊天查看/日报/数据库对比/组件陈列室",
};

// 与控制台同构的应用壳：左侧菜单 + 右侧内容，替换原顶栏横排菜单。
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeScript />
        <div className="flex min-h-screen">
          <ToolboxSidebar />
          <main className="min-w-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-[1720px] px-6 py-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
