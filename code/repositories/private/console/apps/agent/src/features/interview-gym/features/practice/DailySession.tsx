import { useMemo } from "react";
import { useContent } from "@ig/content/useContent";
import { localDateKey } from "@ig/lib/dates";
import { buildLookup } from "@ig/state/lookup";
import { useArena } from "@ig/state/store";
import { useTodaySession } from "@ig/state/useTodaySession";
import { Runner } from "./components/Runner";

// 每日配比会话：结果同时落 attempts 与当日 session.results（仪表盘进度用）
export default function DailySession() {
  const content = useContent();
  const session = useTodaySession();
  const lookup = useMemo(() => buildLookup(content), [content]);
  const saveResult = useArena((s) => s.saveResult);
  const dateKey = localDateKey();

  if (!session) return <p className="text-sm text-muted-foreground">正在生成今日会话…</p>;

  return (
    <Runner
      title="今日会话"
      subtitle={`${dateKey} · 按《十月冲刺计划》配比生成`}
      items={session.items}
      lookup={lookup}
      getProjectBody={(entry) =>
        entry.project ? content.projectBodies[entry.project.slug] : undefined
      }
      onSave={(index, item, scores, note) => saveResult(dateKey, index, item, scores, note)}
    />
  );
}
