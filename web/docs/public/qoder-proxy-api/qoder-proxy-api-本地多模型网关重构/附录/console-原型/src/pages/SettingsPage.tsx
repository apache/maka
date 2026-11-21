import { useStore } from "../store";
import { Card, PageHeader, Toggle } from "../components/ui";

export function SettingsPage() {
  const { gatewayAddr, theme, setTheme, invalidEvents, mode } = useStore();
  const rows: Array<[string, React.ReactNode]> = [
    ["监听地址", <span className="font-mono">{gatewayAddr}（只绑 127.0.0.1）</span>],
    ["控制台", <span className="font-mono">http://{gatewayAddr}/ui</span>],
    ["配置文件", <span className="font-mono">~/.qoder-proxy-api/config.json（Key 单独存 secrets.json，权限 600）</span>],
    ["用量库", <span className="font-mono">~/.qoder-proxy-api/usage.sqlite（node:sqlite）</span>],
    ["数据源", mode === "mock" ? "演示数据（加 ?live=http://127.0.0.1:8320&token=… 连真实网关）" : "实时网关"],
    ["契约校验失败的事件", <span className="font-mono">{invalidEvents}</span>],
    ["深色模式", <Toggle on={theme === "dark"} label="深色模式" onChange={(v) => setTheme(v ? "dark" : "light")} />],
  ];
  return (
    <div>
      <PageHeader title="设置" sub="本机网关的运行参数" />
      <Card className="divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-4 px-4 py-3 text-[12.5px]">
            <span className="w-40 text-muted">{k}</span>
            <span className="flex-1">{v}</span>
          </div>
        ))}
      </Card>
      <Card className="mt-4 p-4 text-[12.5px] leading-relaxed text-muted">
        <div className="mb-1 font-medium text-fg">定位声明</div>
        qoder-proxy-api 是本机的协议网关与多模型路由器：把你自己的多个供应商 Key 统一成 OpenAI / Anthropic 兼容接口。
        它不实现账号池、额度共享或限流绕过；改道只在你配置的路由组内、跨供应商发生，并全部可见。
      </Card>
    </div>
  );
}
