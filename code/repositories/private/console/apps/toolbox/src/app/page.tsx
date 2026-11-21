export default function HomePage() {
  const modules = [
    { href: "/forum", title: "论坛", desc: "mock 论坛：分类/话题/回帖/发帖，本地存储（来源：ggbdpq-site）" },
    { href: "/admin", title: "演示后台", desc: "纯前端 RBAC：用户/角色/菜单/审计（来源：ggbdpq-site）" },
    { href: "/resume", title: "简历编辑器", desc: "编辑 + A4 预览，模板主题切换，本地保存（来源：ggbdpq-site）" },
    { href: "/date-playbook", title: "约会攻略", desc: "地点库 + 情侣空间：计划/复盘/阶段/档案，node:sqlite（来源：date-playbook-miniapp）" },
    { href: "/chat-viewer", title: "聊天查看器", desc: "本地微信聊天查看 + 录屏 OCR，数据不出浏览器（来源：chat-viewer）" },
    { href: "/daily", title: "AI 日报", desc: "离线演示日报：报表/归档/来源健康（来源：ggbdpq-site）" },
    { href: "/database", title: "数据库对比", desc: "8 款数据库 × 6 维度矩阵/对比/分析（来源：ggbdpq-site）" },
    { href: "/ui", title: "组件陈列室", desc: "@ggbdpq/console-ui 46 个组件 live demo" },
  ];
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">总览</h1>
      <p className="mt-1 text-sm text-muted-foreground">产品演示与本地工具集合，与博客(65502)、控制台(65501)分身运行。</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((m) => (
          <a key={m.href} href={m.href} className="group rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/50">
            <h2 className="font-medium group-hover:text-primary">{m.title}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{m.desc}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
