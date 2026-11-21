import Link from "next/link";

const modules = [
  {
    href: "/assets",
    title: "资产台",
    desc: "卡密账号生命周期、ChatGPT 真实额度刷新、CPA tar 导出（来源：card-admin）",
  },
  {
    href: "/inventory",
    title: "库存台",
    desc: "数字权益库存、交易台、市价只读监控（来源：tokens-toolkit）",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-[1720px] px-6 py-6">
      <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">总览</h1>
        <p className="text-sm text-muted-foreground">
          单进程本地控制台；配置/治理/实验室/执行引擎/Worktree/技能管理已迁往 Agent 线（65504）。
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