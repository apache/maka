import { useMemo } from "react";
import { Link, useParams } from "@ig/router";
import { Button } from "@ig/components/ui/button";
import { useContent } from "@ig/content/useContent";
import { BackLink, Runner } from "@ig/features/practice/components/Runner";
import { buildModeItems, PRACTICE_MODES } from "@ig/features/practice/lib/practice";
import type { PracticeMode } from "@ig/features/practice/lib/practice";
import { localDateKey } from "@ig/lib/dates";
import { buildLookup } from "@ig/state/lookup";
import { useArena } from "@ig/state/store";

// 顺序 / 随机 / 错题 / 收藏 四种刷题模式；结果只落 attempts，不占每日会话进度
export default function PracticePage() {
  const content = useContent();
  const { mode } = useParams() as { mode: string };
  const attempts = useArena((s) => s.attempts);
  const bookmarks = useArena((s) => s.bookmarks);
  const recordAttempt = useArena((s) => s.recordAttempt);

  const validMode =
    mode && mode in PRACTICE_MODES && mode !== "daily"
      ? (mode as Exclude<PracticeMode, "daily">)
      : null;
  const lookup = useMemo(() => buildLookup(content), [content]);

  // 每次进入页面重建一次题序，中途刷新不重排（seed 用当天日期）
  const items = useMemo(
    () =>
      validMode
        ? buildModeItems(
            validMode,
            content.bank,
            content.projectCards,
            attempts,
            bookmarks,
            localDateKey(),
          )
        : [],
    [validMode, content, attempts, bookmarks],
  );

  if (!validMode) {
    return (
      <div className="space-y-3">
        <BackLink to="/" label="仪表盘" />
        <p className="text-sm text-muted-foreground">未知刷题模式：{mode}</p>
      </div>
    );
  }

  const meta = PRACTICE_MODES[validMode];

  if (items.length === 0) {
    return (
      <div className="space-y-3">
        <BackLink to="/" label="仪表盘" />
        <h1 className="text-lg font-semibold">{meta.label}</h1>
        <p className="text-sm text-muted-foreground">
          {validMode === "wrong" && "暂无错题。去练一轮，评分有维度低于 2 的题会自动出现在这里。"}
          {validMode === "bookmarked" && "暂无收藏。在题目详情页或练习卡右上角点收藏图标即可加入。"}
        </p>
        <Button asChild variant="outline">
          <Link to="/practice/sequential">先去顺序刷一轮</Link>
        </Button>
      </div>
    );
  }

  return (
    <Runner
      title={meta.label}
      subtitle={`${meta.label} · ${meta.description}`}
      items={items}
      lookup={lookup}
      getProjectBody={(entry) =>
        entry.project ? content.projectBodies[entry.project.slug] : undefined
      }
      onSave={(_index, item, scores, note) =>
        recordAttempt({
          qid: item.qid,
          date: localDateKey(),
          ts: Date.now(),
          kind: item.kind,
          scores,
          note,
        })
      }
      finishLabel="回到仪表盘"
    />
  );
}
