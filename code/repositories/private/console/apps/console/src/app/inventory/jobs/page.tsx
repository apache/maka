'use client';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJson, postJson } from "@/lib/inventory/api";

type ToolkitEvent = {
  id: number;
  type: string;
  payload: unknown;
};

// 任务按钮的公共样式：主操作实底，其余描边，统一走语义 token。
const actionClass =
  "rounded-lg border border-input bg-background px-4 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-50";

export default function JobsPage() {
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJson<{ tools: string[] }>("/api/inventory/jobs"),
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => getJson<{ events: ToolkitEvent[] }>("/api/inventory/events"),
  });
  const invalidateEvents = async () => {
    await queryClient.invalidateQueries({ queryKey: ["events"] });
  };
  const replay = useMutation({
    mutationFn: () =>
      postJson("/api/inventory/jobs/run", {
        name: "replay",
        input: { jobs: [{ type: "replay.sample", payload: { source: "fixture" } }] },
      }),
    onSuccess: invalidateEvents,
  });
  const replenish = useMutation({
    mutationFn: () => postJson("/api/inventory/jobs/run", { name: "replenish" }),
    onSuccess: invalidateEvents,
  });
  const authorizedImport = useMutation({
    mutationFn: () => postJson("/api/inventory/jobs/run", { name: "authorized-import" }),
    onSuccess: async () => {
      await Promise.all([
        invalidateEvents(),
        queryClient.invalidateQueries({ queryKey: ["inventory"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-summary"] }),
      ]);
    },
  });
  const mailInbox = useMutation({
    mutationFn: () => postJson("/api/inventory/jobs/run", { name: "mail-inbox" }),
    onSuccess: invalidateEvents,
  });

  const latest =
    mailInbox.data ?? authorizedImport.data ?? replenish.data ?? replay.data;
  const anyPending =
    replay.isPending || replenish.isPending || authorizedImport.isPending || mailInbox.isPending;

  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">任务回放</h1>
      <p className="text-sm text-muted-foreground">
        已注册工具：{(jobs.data?.tools ?? []).join("、") || "加载中"}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => replay.mutate()}
          disabled={anyPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {replay.isPending ? "回放中…" : "回放 fixture"}
        </button>
        <button
          type="button"
          onClick={() => replenish.mutate()}
          disabled={anyPending}
          className={actionClass}
        >
          {replenish.isPending ? "执行中…" : "执行补池"}
        </button>
        <button
          type="button"
          onClick={() => authorizedImport.mutate()}
          disabled={anyPending}
          className={actionClass}
        >
          {authorizedImport.isPending ? "导入中…" : "授权导入"}
        </button>
        <button
          type="button"
          onClick={() => mailInbox.mutate()}
          disabled={anyPending}
          className={actionClass}
        >
          {mailInbox.isPending ? "收信中…" : "收信 fixture"}
        </button>
      </div>
      {latest ? (
        <pre className="overflow-x-auto rounded-xl border bg-card p-4 font-mono text-xs">{JSON.stringify(latest, null, 2)}</pre>
      ) : null}
      <article className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 font-medium">事件日志</h2>
        <ol className="space-y-1 text-sm text-muted-foreground">
          {(events.data?.events ?? []).length === 0 ? (
            <li>还没有事件。执行回放、导入、收信或补池后会出现可回放记录。</li>
          ) : (
            (events.data?.events ?? []).map((event) => (
              <li key={event.id} className="tnum">
                {event.id}. {event.type}
              </li>
            ))
          )}
        </ol>
      </article>
    </section>
  );
}
