import { useStore } from "../store";
import { keyOf } from "../contracts";
import { Badge, Button, Card, Dot, Mark, PageHeader, Toggle } from "../components/ui";

const KIND: Record<string, string> = {
  "qoder-gateway": "Qoder · 内置",
  "qoder-cli": "Qoder CLI · 内置",
  "qoder-cloudAgents": "Qoder Cloud Agents · 内置",
  "openai-compatible": "OpenAI 兼容",
  "anthropic-compatible": "Anthropic 兼容",
};

export function ProvidersPage() {
  const { providers, health, now, resetHealth } = useStore();
  return (
    <div>
      <PageHeader
        title="供应商"
        sub="每个供应商 = 一个上游地址 + 一把你自己的 Key。Key 只存在本机配置里，页面只显示尾 4 位。"
        right={<Button variant="pill">＋ 添加供应商</Button>}
      />
      <Card className="divide-y divide-line">
        {providers.map((p) => {
          const resting = p.models.map((m) => ({ m, h: health[keyOf({ providerId: p.id, model: m })] })).filter((x) => x.h && x.h.restUntil > now);
          return (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <Mark id={p.id} label={p.label} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium">
                  {p.label} <Badge>{KIND[p.kind]}</Badge>
                  {p.capabilities.tools && <Badge tone="accent">工具</Badge>}
                  {p.capabilities.vision && <Badge tone="accent">图片</Badge>}
                  {p.capabilities.thinking && <Badge tone="accent">思考</Badge>}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-muted">
                  {resting.length ? (
                    <><Dot tone="bad" /><span className="text-bad">{resting.map((x) => `${x.m} ${x.h!.reason}`).join("；")}</span>
                      <button className="text-accent hover:underline" onClick={() => resting.forEach((x) => resetHealth({ providerId: p.id, model: x.m }))}>立即恢复</button></>
                  ) : p.enabled ? (
                    <><Dot tone="ok" />可用</>
                  ) : (
                    <><Dot tone="muted" />已停用</>
                  )}
                  {p.baseUrl && <> · <span className="font-mono">{p.baseUrl}</span></>}
                  {p.keyHint && <> · Key <span className="font-mono">••••{p.keyHint}</span></>}
                  {" "}· {p.models.length} 个模型
                </div>
              </div>
              <Button>编辑</Button>
              <Toggle on={p.enabled} label={`启用 ${p.label}`} onChange={(v) => useStore.setState((s) => ({ providers: s.providers.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) }))} />
            </div>
          );
        })}
      </Card>
      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        不支持为同一服务添加多个账号来轮换额度。每个供应商只接受它官方提供的 API Key / Token。
      </p>
    </div>
  );
}
