import { useMemo, useState } from "react";
import { useStore } from "../store";
import { RouteGroup } from "../contracts";
import type { MemberRef } from "../contracts";
import { Topology } from "./Topology";
import { narrate } from "./trace";
import { Badge, Button, Card, cx, Dot, Modal, PageHeader, PillSelect, XIcon } from "../components/ui";

export function RoutingPage() {
  const { groups, active, finished, traces, providers, agents, upsertGroup } = useStore();
  const [pinned, setPinned] = useState<string | null>(null);
  const [editing, setEditing] = useState<RouteGroup | "new" | null>(null);

  // 默认跟随"此刻最忙的组"；用户点选后固定
  const busiest = useMemo(() => {
    const count = (id: string) => Object.values(active).filter((r) => r.groupId === id).length;
    return [...groups].sort((a, b) => count(b.id) - count(a.id))[0]?.id;
  }, [active, groups]);
  const group = groups.find((g) => g.id === (pinned ?? busiest)) ?? groups[0];
  const label = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

  const inGroup = Object.values(active).filter((r) => r.groupId === group.id);
  const sendingAgents = new Set(inGroup.map((r) => r.agent)).size;
  const done = finished.filter((f) => f.groupId === group.id);
  const stats = { requests: done.length, reroutes: done.reduce((n, f) => n + f.reroutes, 0), errors: done.filter((f) => f.outcome === "error").length };
  const last = [...done].reverse().find((f) => traces[f.requestId]);
  const lastTrace = last ? narrate(traces[last.requestId], providers) : [];
  const enabledMembers = group.members.filter((m) => providers.find((p) => p.id === m.providerId)?.enabled).length;

  return (
    <div>
      <PageHeader title="路由" sub={<><Dot tone="ok" live /> 实时 · 网关正在做的决定</>} />

      <Card className="p-5">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold">{group.name}</span>
          <span className="text-[12.5px] text-muted">
            · 路由组 · 启用 {enabledMembers} 个 · {sendingAgents > 0 ? `${sendingAgents} 个 Agent 同时在发` : "此刻空闲"}
          </span>
          {pinned && <Button className="ml-auto" onClick={() => setPinned(null)}>跟随最忙的组</Button>}
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          {group.strategy === "smart"
            ? "智能：同一会话优先回到上次回答它的上游（缓存更可能命中），否则挑最近没出错、并发最少、首字最快的。还没给 Agent 发出任何内容前失败，就换下一个；已经开始回答就不换。"
            : `按顺序：${group.members.map((m) => label(m.providerId)).join(" → ")}。前一个在歇或首字节前失败才用下一个；已经开始回答就不换。`}
        </p>

        <div className="mt-4">
          <Topology group={group} />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          {[
            { n: stats.requests, t: "请求" },
            { n: stats.reroutes, t: "改道", tone: stats.reroutes ? "text-warn" : "" },
            { n: stats.errors, t: "Agent 收到的错误", tone: stats.errors ? "text-bad" : "text-ok" },
          ].map((s) => (
            <div key={s.t} className="rounded-xl bg-pill px-3 py-2">
              <div className={cx("font-mono text-[18px] font-semibold", s.tone)}>{s.n}</div>
              <div className="text-[11.5px] text-muted">{s.t}</div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-1.5 text-[12.5px] font-medium">最近一个请求是怎么路由的</div>
          {lastTrace.length === 0 ? (
            <div className="text-[12px] text-faint">还没有完成的请求</div>
          ) : (
            <ul className="space-y-1">
              {lastTrace.map((l, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed">
                  <span className="flex h-[19.5px] items-center"><Dot tone={l.tone} /></span>
                  <span className={l.tone === "bad" ? "text-bad" : l.tone === "warn" ? "text-warn" : ""}>{l.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="mb-2 mt-6 flex items-center justify-between">
        <div className="text-[14px] font-semibold">路由组</div>
        <Button variant="pill" onClick={() => setEditing("new")}>＋ 新建组</Button>
      </div>
      <Card className="divide-y divide-line">
        {groups.map((g) => {
          const live = Object.values(active).filter((r) => r.groupId === g.id).length;
          const users = agents.filter((a) => a.model === `group/${g.id}`).length;
          return (
            <div key={g.id} className={cx("flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-pill/60", g.id === group.id && "bg-sel/60")} onClick={() => setPinned(g.id)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {g.name}
                  <span className="font-mono text-[11px] font-normal text-muted">group/{g.id}</span>
                  {live > 0 && <span className="flex items-center gap-1 text-[11px] font-normal text-ok"><Dot tone="ok" live />{live} 个在途</span>}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted">
                  {g.strategy === "smart" ? <Badge tone="accent">智能</Badge> : <Badge>按顺序</Badge>}{" "}
                  {g.members.map((m) => label(m.providerId)).join(g.strategy === "ordered" ? " → " : " · ")} · {users} 个 Agent 在用
                </div>
              </div>
              <Button onClick={(e) => { e.stopPropagation(); setEditing(g); }}>编辑</Button>
            </div>
          );
        })}
      </Card>
      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        改道只发生在你配置的组内、跨供应商或跨 Key 之间，并且每一次都显示在这里。本项目不做同一服务的多账号轮换或额度共享。
      </p>

      {editing && (
        <GroupEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(g) => {
            upsertGroup(g);
            setPinned(g.id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function GroupEditor({ initial, onClose, onSave }: { initial: RouteGroup | null; onClose: () => void; onSave: (g: RouteGroup) => void }) {
  const { providers, groups } = useStore();
  const [draft, setDraft] = useState<RouteGroup>(initial ?? { id: "", name: "", strategy: "ordered", enabled: true, members: [] });
  const [errors, setErrors] = useState<string[]>([]);
  const all: MemberRef[] = providers.filter((p) => p.enabled).flatMap((p) => p.models.map((model) => ({ providerId: p.id, model })));
  const [pick, setPick] = useState(`${all[0]?.providerId}/${all[0]?.model}`);
  const move = (i: number, d: number) => {
    const ms = [...draft.members];
    const j = i + d;
    if (j < 0 || j >= ms.length) return;
    [ms[i], ms[j]] = [ms[j], ms[i]];
    setDraft({ ...draft, members: ms });
  };
  const save = () => {
    const r = RouteGroup.safeParse(draft);
    const dup = !initial && groups.some((g) => g.id === draft.id);
    if (!r.success || dup) {
      setErrors([...(r.success ? [] : r.error.issues.map((i) => `${i.path.join(".") || "组"}：${i.message}`)), ...(dup ? ["id：已存在"] : [])]);
      return;
    }
    onSave(r.data);
  };
  return (
    <Modal open onClose={onClose} title={initial ? `编辑 ${initial.name}` : "新建路由组"} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
      <div className="space-y-3 text-[12.5px]">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <div className="text-muted">名称</div>
            <input className="w-full rounded-lg border border-line bg-card px-2 py-1.5 outline-none focus:border-accent" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, id: initial ? draft.id : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })} />
          </label>
          <label className="space-y-1">
            <div className="text-muted">调用名</div>
            <div className="rounded-lg bg-pill px-2 py-1.5 font-mono">group/{draft.id || "…"}</div>
          </label>
        </div>
        <div className="space-y-1">
          <div className="text-muted">策略</div>
          <div className="flex gap-2">
            {(["ordered", "smart"] as const).map((s) => (
              <button key={s} onClick={() => setDraft({ ...draft, strategy: s })} className={cx("rounded-lg border px-3 py-1.5", draft.strategy === s ? "border-accent bg-accent-soft text-accent" : "border-line")}>
                {s === "smart" ? "智能（亲和 + 健康 + 速度）" : "按顺序（第一个不行才用下一个）"}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-muted">成员（顺序即优先级）</div>
          {draft.members.map((m, i) => (
            <div key={`${m.providerId}/${m.model}`} className="flex items-center gap-2 rounded-lg bg-pill px-2 py-1">
              <span className="w-4 text-faint">{i + 1}</span>
              <span className="flex-1 font-mono">{m.providerId}/{m.model}</span>
              <Button onClick={() => move(i, -1)} aria-label="上移">↑</Button>
              <Button onClick={() => move(i, 1)} aria-label="下移">↓</Button>
              <Button onClick={() => setDraft({ ...draft, members: draft.members.filter((_, j) => j !== i) })} aria-label="移除"><XIcon /></Button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <PillSelect value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-none flex-1">
              {all.map((m) => <option key={`${m.providerId}/${m.model}`}>{m.providerId}/{m.model}</option>)}
            </PillSelect>
            <Button variant="pill" onClick={() => {
              const [providerId, ...rest] = pick.split("/");
              const ref = { providerId, model: rest.join("/") };
              if (!draft.members.some((m) => m.providerId === ref.providerId && m.model === ref.model)) setDraft({ ...draft, members: [...draft.members, ref] });
            }}>添加</Button>
          </div>
        </div>
        {errors.length > 0 && <ul className="rounded-lg bg-bad-soft px-3 py-2 text-bad">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      </div>
    </Modal>
  );
}
