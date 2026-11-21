'use client';

// worktree 工作台：项目注册 + Agent（worktree）生命周期管理。
// 降栈自 ai-worktree-commander 桌面壳：Tauri invoke → HTTP fetch，UI 布局保留双面板结构。

import { useCallback, useEffect, useState } from "react";
import { cn } from "@ggbdpq/console-ui";

interface Project {
  id: string;
  name: string;
  path: string;
  branch: string;
  status: "Clean" | "Dirty" | "unknown";
}

interface Agent {
  id: string;
  name: string;
  branch: string;
  path: string;
  projectId: string;
}

interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

const http = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api/worktree${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(body.message ?? `请求失败 ${res.status}`);
  return body as T;
};

export default function WorktreePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [agentName, setAgentName] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [commits, setCommits] = useState<Record<string, Commit[]>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProjects((await http<{ projects: Project[] }>("/projects")).projects);
      setAgents((await http<{ agents: Agent[] }>("/agents")).agents);
    } catch (e) {
      setMessage({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>, okText: string) => {
    setBusy(true);
    try {
      await fn();
      setMessage({ tone: "ok", text: okText });
      await refresh();
    } catch (e) {
      setMessage({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const addProject = () =>
    run(async () => {
      await http("/projects", { method: "POST", body: JSON.stringify({ name, path }) });
      setName("");
      setPath("");
    }, "项目已添加");

  const spawnAgent = () => {
    if (!selected) return;
    return run(async () => {
      await http("/agents", {
        method: "POST",
        body: JSON.stringify({ projectId: selected.id, agentName }),
      });
      setAgentName("");
    }, "Agent 已创建（worktree + 分支）");
  };

  const agentAction = (id: string, action: string, okText: string) =>
    run(async () => {
      await http(`/agents/${id}/${action}`, { method: "POST", body: JSON.stringify({}) });
      if (action === "commits") {
        const r = await http<{ commits: Commit[] }>(`/agents/${id}/commits`, { method: "POST", body: "{}" });
        setCommits((prev) => ({ ...prev, [id]: r.commits }));
        setMessage({ tone: "ok", text: "提交历史已刷新" });
      }
    }, okText);

  const projectAgents = selected ? agents.filter((a) => a.projectId === selected.id) : agents;

  return (
    <div className="mx-auto max-w-[1720px] space-y-6 px-6 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Worktree 台</h1>
        <p className="text-sm text-muted-foreground">
          多项目 git worktree 管理：为项目生成 Agent 工作树（独立分支+目录），改完同步主分支或合并回收。
        </p>
      </header>

      {message && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            message.tone === "ok"
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {message.text}
        </div>
      )}

      {/* 项目注册 */}
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="text-sm font-medium">注册项目</div>
        <div className="flex flex-wrap gap-2">
          <input
            className="w-48 rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="min-w-72 flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm"
            placeholder="仓库绝对路径"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void run(addProject, "项目已添加")}
            disabled={busy || !name.trim() || !path.trim()}
          >
            添加
          </button>
        </div>
      </section>

      {/* 项目列表 */}
      <section className="space-y-2">
        <div className="text-sm font-medium">项目（点击选中）</div>
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            暂无项目——注册一个本地 git 仓库开始
          </div>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className={cn(
                  "cursor-pointer rounded-xl border bg-card p-4 transition-colors hover:border-ring",
                  selected?.id === p.id ? "border-ring" : "",
                )}
                onClick={() => setSelected(p)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{p.name}</span>
                    <span className={cn("ml-3 text-xs", p.status === "Clean" ? "text-success" : "text-warning")}>
                      {p.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="rounded border px-2 py-1 text-xs"
                      onClick={() => void run(() => http(`/projects/${p.id}/pull`, { method: "POST", body: "{}" }).then(() => undefined), "已拉取")}
                      disabled={busy}
                    >
                      pull
                    </button>
                    <button
                      className="rounded border px-2 py-1 text-xs text-destructive"
                      onClick={() => void run(() => http(`/projects/${p.id}/remove`, { method: "POST", body: "{}" }).then(() => undefined), "项目已移除")}
                      disabled={busy}
                    >
                      移除
                    </button>
                  </div>
                </div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  {p.path} · {p.branch}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Agent 区（需选中项目） */}
      {selected && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="text-sm font-medium">
            Agents · {selected.name}{" "}
            <span className="ml-1 text-xs text-muted-foreground">（主分支 {selected.branch}）</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="w-56 rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Agent 名称（如 worker-a）"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
              onClick={() => agentName.trim() && spawnAgent()}
              disabled={busy || !agentName.trim()}
            >
              生成 Agent（worktree）
            </button>
          </div>

          {projectAgents.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              该项目暂无 Agent
            </div>
          ) : (
            <ul className="space-y-2">
              {projectAgents.map((a) => (
                <li key={a.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-medium">{a.name}</span>
                      <span className="ml-2 font-mono text-xs text-info">{a.branch}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(["sync", "merge"] as const).map((act) => (
                        <button
                          key={act}
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => void agentAction(a.id, act, act === "sync" ? "已同步主分支" : "已合并到主分支")}
                          disabled={busy}
                        >
                          {act === "sync" ? "同步主分支" : "合并回收"}
                        </button>
                      ))}
                      <button
                        className="rounded border px-2 py-0.5 text-xs"
                        onClick={() => void agentAction(a.id, "commits", "已刷新")}
                        disabled={busy}
                      >
                        提交历史
                      </button>
                      <button
                        className="rounded border px-2 py-0.5 text-xs"
                        onClick={() => void agentAction(a.id, "diff", "已刷新 diff")}
                        disabled={busy}
                      >
                        diff
                      </button>
                      <button
                        className="rounded border px-2 py-0.5 text-xs text-destructive"
                        onClick={() => void agentAction(a.id, "remove", "Agent 已回收（worktree+分支删除）")}
                        disabled={busy}
                      >
                        回收
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">{a.path}</div>
                  {commits[a.id] && (
                    <ul className="mt-2 space-y-1 border-t pt-2">
                      {commits[a.id]!.map((c) => (
                        <li key={c.hash} className="font-mono text-xs text-muted-foreground">
                          <span className="text-info">{c.hash}</span> {c.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
