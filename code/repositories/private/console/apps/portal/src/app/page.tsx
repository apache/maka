import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@ggbdpq/console-ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hub · 应用门户",
  description: "个人四应用入口：控制台 / 博客 / 工具箱 / Agent 工作台",
};

const apps = [
  {
    href: "http://localhost:65501",
    port: 65501,
    name: "Console",
    label: "运维控制台",
    desc: "资产台 / 库存台 / 注册台 / 工具集 / 清单台 —— 个人运维一站式",
    dark: false,
  },
  {
    href: "http://localhost:65502",
    port: 65502,
    name: "Blog",
    label: "个人博客",
    desc: "朋友圈 / 文章与算法判题 / 成长 / 动漫 / 技能展示",
    dark: true,
  },
  {
    href: "http://localhost:65503",
    port: 65503,
    name: "Toolbox",
    label: "演示与本地工具",
    desc: "论坛 / 演示后台 / 简历编辑器 / 约会攻略 / 聊天查看器 / 日报 / 数据库对比",
    dark: false,
  },
  {
    href: "http://localhost:65504",
    port: 65504,
    name: "Agent",
    label: "AI Agent 工作台",
    desc: "配置台 / 治理台 / 实验室 / 执行引擎 / Worktree 台 / 技能管理",
    dark: true,
  },
];

// 苹果官网式大气布局：大标题 hero + 全宽大磁贴交替明暗，链接一律新标签页打开。
export default function HomePage() {
  return (
    <div className="mx-auto max-w-[1440px] px-6">
      <section className="py-24 text-center md:py-32">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          Personal Hub
        </p>
        <h1 className="mt-4 text-5xl font-semibold leading-[1.07] tracking-tight md:text-6xl">
          一切应用，自此出发。
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-xl font-light leading-relaxed text-muted-foreground md:text-2xl">
          控制台、博客、工具箱与 Agent 工作台各自独立端口运行，互不影响，一键全启。
        </p>
      </section>

      <section className="flex flex-col gap-6 pb-24">
        {apps.map((app) => (
          <Link
            key={app.port}
            href={app.href}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "group flex flex-col gap-10 rounded-[18px] border p-10 transition md:flex-row md:items-center md:justify-between md:p-16",
              app.dark
                ? "border-transparent bg-foreground text-background"
                : "border-border/60 bg-card hover:border-primary/40",
            )}
          >
            <div className="max-w-2xl">
              <div
                className={cn(
                  "flex items-baseline gap-3",
                  app.dark && "text-background",
                )}
              >
                <span className="text-4xl font-semibold tracking-tight md:text-5xl">
                  {app.name}
                </span>
                <span
                  className={cn(
                    "font-mono text-sm",
                    app.dark ? "text-background/60" : "text-muted-foreground",
                  )}
                >
                  :{app.port}
                </span>
              </div>
              <p
                className={cn(
                  "mt-3 text-xl md:text-2xl",
                  app.dark ? "font-light text-background/60" : "font-medium",
                )}
              >
                {app.label}
              </p>
              <p
                className={cn(
                  "mt-4 leading-relaxed",
                  app.dark ? "text-background/75" : "text-muted-foreground",
                )}
              >
                {app.desc}
              </p>
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-full px-7 py-3 text-lg transition-transform group-hover:scale-[0.97]",
                app.dark
                  ? "bg-background text-foreground"
                  : "bg-primary text-primary-foreground",
              )}
            >
              进入应用
              <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
            </span>
          </Link>
        ))}
      </section>

      <footer className="pb-10 text-center text-xs text-muted-foreground">
        一键全启：<code className="rounded bg-muted px-1.5 py-0.5">pnpm dev</code>
        （本页 65515 会随之启动） · 日常使用建议 <code className="rounded bg-muted px-1.5 py-0.5">pnpm start</code>
        （生产模式，页面秒开）· 各应用在新标签页打开
      </footer>
    </div>
  );
}
