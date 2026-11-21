import { useMemo, useState } from "react";
import { useStore } from "../store";
import { agentColor } from "../seed";
import { configPreview } from "../configPreview";
import { Badge, Button, Card, cx, Dot, Mark, Modal, PageHeader, PillSelect, Toggle } from "../components/ui";
import type { AgentIntegration } from "../contracts";

const OTHERS = [
  { id: "crush", name: "Crush" },
  { id: "gemini-cli", name: "Gemini CLI" },
  { id: "zed", name: "Zed" },
];

export function AgentPage() {
  const { agents, groups, providers, active, plans, activePlan, applyPlan, savePlan, setAgentModel, setAgentConnected, gatewayAddr } = useStore();
  const [confirm, setConfirm] = useState<{ agent: AgentIntegration; connect: boolean } | null>(null);
  const [models, setModels] = useState<AgentIntegration | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [naming, setNaming] = useState(false);
  const [planName, setPlanName] = useState("");

  const options = useMemo(
    () => [
      { label: "路由组", items: groups.filter((g) => g.enabled).map((g) => ({ value: `group/${g.id}`, text: `group/${g.id}` })) },
      ...providers.filter((p) => p.enabled).map((p) => ({ label: p.label, items: p.models.map((m) => ({ value: `${p.id}/${m}`, text: `${p.id}/${m}` })) })),
    ],
    [groups, providers],
  );
  const modelCount = options.reduce((n, o) => n + o.items.length, 0);
  const connectedCount = agents.filter((a) => a.connected).length;

  return (
    <div>
      <PageHeader
        title="Agent"
        sub={<><Dot tone="ok" /> {connectedCount} 个已接入 · 它们的请求都经过本机网关，可在「路由」页看到每一次决定</>}
      />
      <Card className="divide-y divide-line">
        {agents.map((a) => {
          const sending = Object.values(active).filter((r) => r.agent === a.id);
          return (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3">
              <Mark id={a.id} label={a.name} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium">
                  {a.name}
                  {sending.length > 0 && (
                    <span className="flex items-center gap-1 text-[11.5px] font-normal" style={{ color: agentColor[a.id] }}>
                      <span className="dot-live inline-block h-[6px] w-[6px] rounded-full" style={{ background: agentColor[a.id] }} />
                      正在发 {sending.length} 个请求
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-muted">
                  {a.connected ? (
                    <><Dot tone="ok" /><span className="text-ok">已接入</span> · {a.note}</>
                  ) : a.detected ? (
                    <><Dot tone="muted" />未接入 · 检测到 <span className="font-mono">{a.configPath}</span></>
                  ) : (
                    <><Dot tone="muted" />未安装</>
                  )}
                </div>
              </div>
              <Button onClick={() => setModels(a)} title="可选模型">
                模型 <span className="font-mono text-fg">{modelCount}</span> ›
              </Button>
              <PillSelect value={a.model} disabled={!a.connected} onChange={(e) => setAgentModel(a.id, e.target.value)} aria-label={`${a.name} 使用的模型`}>
                {options.map((o) => (
                  <optgroup key={o.label} label={o.label}>
                    {o.items.map((i) => <option key={i.value} value={i.value}>{i.text}</option>)}
                  </optgroup>
                ))}
              </PillSelect>
              <Toggle on={a.connected} label={`接入 ${a.name}`} onChange={(v) => setConfirm({ agent: a, connect: v })} />
            </div>
          );
        })}
        {showOthers &&
          OTHERS.map((o) => (
            <div key={o.id} className="flex items-center gap-3 px-4 py-3 opacity-55">
              <Mark id={o.id} label={o.name} size={32} />
              <div className="flex-1">
                <div className="text-[13.5px] font-medium">{o.name}</div>
                <div className="text-[12px] text-muted">暂不支持 · 先把 3 个做扎实（见 ADR-0009）</div>
              </div>
              <Toggle on={false} label={o.name} onChange={() => {}} />
            </div>
          ))}
        <button className="w-full px-4 py-2.5 text-left text-[12.5px] text-muted hover:text-fg" onClick={() => setShowOthers((v) => !v)}>
          {showOthers ? "收起" : `显示其余 ${OTHERS.length} 个`}
        </button>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[12px] text-muted">方案</span>
        {plans.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPlan(p.id)}
            className={cx("rounded-full border px-3 py-1 text-[12.5px]", activePlan === p.id ? "border-accent bg-accent-soft text-accent" : "border-line bg-card text-fg hover:bg-pill")}
          >
            {p.name}
          </button>
        ))}
        {naming ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (planName.trim()) savePlan(planName.trim());
              setNaming(false);
              setPlanName("");
            }}
          >
            <input autoFocus value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="方案名" className="w-28 rounded-full border border-line bg-card px-3 py-1 text-[12.5px] outline-none focus:border-accent" />
            <Button type="submit" variant="pill">保存</Button>
          </form>
        ) : (
          <button onClick={() => setNaming(true)} className="rounded-full border border-dashed border-line px-3 py-1 text-[12.5px] text-muted hover:text-fg">＋ 保存当前</button>
        )}
        <span className="ml-auto text-[11.5px] text-faint">方案 = 每个 Agent 用哪个模型的一组快照，一键切换</span>
      </div>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? (confirm.connect ? `接入 ${confirm.agent.name}` : `断开 ${confirm.agent.name}`) : ""}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (confirm) setAgentConnected(confirm.agent.id, confirm.connect);
                setConfirm(null);
              }}
            >
              {confirm?.connect ? "备份并写入" : "从备份恢复"}
            </Button>
          </>
        }
      >
        {confirm && confirm.connect && (() => {
          const p = configPreview(confirm.agent.id, confirm.agent.model, gatewayAddr);
          return (
            <div className="space-y-3 text-[12.5px]">
              <p className="text-muted">将修改 <span className="font-mono text-fg">{p.path}</span>。写入前先完整备份原文件；断开时原样恢复。</p>
              <pre className="overflow-auto rounded-xl bg-pill p-3 font-mono text-[11.5px] leading-relaxed">{p.body}</pre>
              <p className="text-muted">Key 是本网关为该 Agent 单独生成的下游 Key（用于区分用量），不是任何供应商的 Key。</p>
            </div>
          );
        })()}
        {confirm && !confirm.connect && (
          <div className="space-y-2 text-[12.5px]">
            <p>将用备份恢复 <span className="font-mono">{confirm.agent.configPath}</span>：</p>
            <p className="font-mono text-muted">{confirm.agent.backupPath ?? "（没有备份：只删除本网关写入的键）"}</p>
            <p className="text-muted">如果接入后你手动改过该文件，会先展示三方差异，不会静默覆盖。</p>
          </div>
        )}
      </Modal>

      <Modal open={!!models} onClose={() => setModels(null)} title={`${models?.name ?? ""} 可用的模型`}>
        <div className="space-y-4">
          {options.map((o) => (
            <div key={o.label}>
              <div className="mb-1 text-[11.5px] font-medium text-muted">{o.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {o.items.map((i) => (
                  <button
                    key={i.value}
                    onClick={() => {
                      if (models) setAgentModel(models.id, i.value);
                      setModels(null);
                    }}
                    className={cx("rounded-lg px-2 py-1 font-mono text-[11.5px]", models?.model === i.value ? "bg-accent-soft text-accent" : "bg-pill hover:bg-sel")}
                  >
                    {i.text}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex gap-2 text-[11.5px] text-muted">
            <Badge tone="accent">group/</Badge> 由网关按策略挑选并在失败时显式改道；<Badge>provider/model</Badge> 直连、不改道。
          </div>
        </div>
      </Modal>
    </div>
  );
}
