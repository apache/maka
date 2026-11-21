'use client';

// workflow 工作台：任务列表 + 创建 + 执行状态实时刷新（SSE + 轮询兜底）。

import { useCallback, useEffect, useState } from "react";
import { cn } from "@ggbdpq/console-ui";

interface TaskItem {
  id: string;
  title: string;
  createdAt: string;
}

interface ExecutionItem {
  id: string;
  jobId: string;
  status: string;
  progress: number;
  attemptNumber: number;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  PENDING: "text-muted-foreground",
  CLAIMED: "text-info",
  RUNNING: "text-info",
  COMPLETED: "text-success",
  FAILED: "text-destructive",
  TIMEOUT: "text-warning",
  CANCELLED: "text-muted-foreground",
};

export default function WorkflowPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [detail, setDetail] = useState<{ task: TaskItem; executions: ExecutionItem[] } | null>(null);
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("{}");
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/workflow/tasks");
    if (res.ok) setTasks(((await res.json()) as { tasks: TaskItem[] }).tasks);
    if (detail) {
      const d = await fetch(`/api/workflow/tasks/${detail.task.id}`);
      if (d.ok) setDetail((await d.json()) as { task: TaskItem; executions: ExecutionItem[] });
    }
  }, [detail]);

  // SSE 实时刷新（断线自动降级轮询）
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    try {
      es = new EventSource("/api/workflow/events");
      es.onopen = () => setLive(true);
      es.onmessage = () => void refresh();
      es.onerror = () => {
        setLive(false);
        if (!poll) poll = setInterval(() => void refresh(), 5000);
      };
    } catch {
      poll = setInterval(() => void refresh(), 5000);
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [refresh]);

  const create = async () => {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(spec);
    } catch {
      return;
    }
    await fetch("/api/workflow/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, spec: parsed }),
    });
    setTitle("");
    await refresh();
  };

  const act = async (path: string, body?: unknown) => {
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    await refresh();
  };

  const openDetail = async (id: string) => {
    const d = await fetch(`/api/workflow/tasks/${id}`);
    if (d.ok) setDetail((await d.json()) as { task: TaskItem; executions: ExecutionItem[] });
  };

  return (
    <div className="mx-auto max-w-[1720px] space-y-6 px-6 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">执行引擎</h1>
        <p className="text-sm text-muted-foreground">
          任务执行引擎（状态机：PENDING → CLAIMED → RUNNING → COMPLETED/FAILED/TIMEOUT/CANCELLED）
          {live ? " · SSE 实时" : " · 轮询模式"}
        </p>
      </header>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap gap-2">
          <input
            className="w-56 rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="任务标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="min-w-72 flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm"
            placeholder='spec JSON，如 {"cmd":"test"}'
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
          />
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void create()}
            disabled={!title.trim()}
          >
            创建任务
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm font-medium">任务列表（{tasks.length}）</div>
        {tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            暂无任务——先在上方创建一个
          </div>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t) => (
              <li
                key={t.id}
                className={cn(
                  "cursor-pointer rounded-xl border bg-card p-4 transition-colors hover:border-ring",
                  detail?.task.id === t.id ? "border-ring" : "",
                )}
                onClick={() => void openDetail(t.id)}
              >
                <div className="font-medium">{t.title}</div>
                <div className="text-xs text-muted-foreground">{t.createdAt.slice(0, 19).replace("T", " ")}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="font-medium">{detail.task.title} 的执行记录</div>
            <div className="flex gap-2">
              <button
                className="rounded-md border px-3 py-1.5 text-xs"
                onClick={() => void act(`/api/workflow/tasks/${detail.task.id}/rerun`)}
              >
                重跑（新 PENDING）
              </button>
              <button
                className="rounded-md border px-3 py-1.5 text-xs text-destructive"
                onClick={() => void act(`/api/workflow/tasks/${detail.task.id}/cancel`)}
              >
                取消
              </button>
              <button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          </div>
          <ul className="space-y-2">
            {detail.executions.map((e) => (
              <li key={e.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className={cn("font-mono font-medium", STATUS_TONE[e.status] ?? "")}>
                    #{e.attemptNumber} {e.status}
                  </span>
                  <span className="flex gap-1">
                    {e.status === "CLAIMED" && (
                      <button
                        className="rounded border px-2 py-0.5 text-xs"
                        onClick={() => void act(`/api/workflow/executions/${e.id}/start`)}
                      >
                        start
                      </button>
                    )}
                    {e.status === "RUNNING" && (
                      <>
                        <button
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => void act(`/api/workflow/executions/${e.id}/progress`, { progress: 50, currentStep: "manual" })}
                        >
                          progress 50%
                        </button>
                        <button
                          className="rounded border px-2 py-0.5 text-xs text-success"
                          onClick={() => void act(`/api/workflow/executions/${e.id}/complete`, { result: { manual: true } })}
                        >
                          complete
                        </button>
                        <button
                          className="rounded border px-2 py-0.5 text-xs text-destructive"
                          onClick={() => void act(`/api/workflow/executions/${e.id}/fail`, { error: { message: "manual" } })}
                        >
                          fail
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-2 h-1.5 rounded bg-muted">
                  <div className="h-1.5 rounded bg-primary transition-all" style={{ width: `${e.progress}%` }} />
                </div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">{e.jobId}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
