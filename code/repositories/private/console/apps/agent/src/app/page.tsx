import Link from "next/link";

const modules = [
  {
    href: "/agentops",
    title: "配置台",
    desc: "编辑器配置扫描、计划、备份、回滚（来源：config-engine）",
  },
  {
    href: "/governance",
    title: "治理台",
    desc: "prd.json / progress.txt / Git 三向联查（来源：governance，解析已后端化）",
  },
  {
    href: "/lab",
    title: "实验室",
    desc: "浏览器活跑 coding agent，23 关教学走读（来源：pi-web-dev）",
  },
  {
    href: "/workflow",
    title: "执行引擎",
    desc: "Agent 任务列表、创建与执行状态实时刷新（SSE + 轮询兜底）",
  },
  {
    href: "/worktree",
    title: "Worktree 台",
    desc: "项目注册 + Agent（worktree）生命周期管理（来源：ai-worktree-commander）",
  },
  {
    href: "/course",
    title: "课程",
    desc: "「理解大模型 · 从 Token 到 Agent」16 课交互课程（来源：token2agent）",
  },
  {
    href: "/deck",
    title: "幻灯片",
    desc: "「如何 Harness 我的大模型」23 页演讲稿（来源：harness-deck）",
  },
  {
    href: "/interview-gym",
    title: "面试自练场",
    desc: "闭卷题库、项目口述与模拟面试（2026-10-03 自独立应用并入）",
  },
  {
    href: "/diffmap",
    title: "变更审查",
    desc: "AI 大批量变更的 treemap 自审台（来源：diffmap）",
  },
  {
    href: "/ruoyi-ai",
    title: "RuoYi AI 知识库",
    desc: "纯前端 RAG 全链路：分片 → 向量 → 检索 → 回答（2026-10-25 自 ruoyi-ai-web 并入）",
  },
  {
    href: "/downloads",
    title: "下载台",
    desc: "URL → yt-dlp 视频下载，B站/YouTube/X（2026-10-25 自 linkpull 承接）",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-[1720px] px-6 py-6">
      <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">总览</h1>
        <p className="text-sm text-muted-foreground">
          AI Agent 线统一工作台，八个模块同仓同栈（与控制台 65501 / 博客 65502 / 工具箱 65503 分身运行）。
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="rounded-xl border bg-card p-5 shadow-sm transition-colors hover:border-ring"
          >
            <div className="font-medium">{m.title}</div>
            <p className="mt-2 text-sm text-muted-foreground">{m.desc}</p>
          </Link>
        ))}
      </div>
    </div>
    </div>
  );
}
