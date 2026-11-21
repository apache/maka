import { useMemo } from "react";
import { Link } from "@ig/router";
import {
  ArrowRight,
  Bot,
  Bookmark,
  Layers,
  ListOrdered,
  RefreshCcw,
  Shuffle,
  TriangleAlert,
} from "lucide-react";
import { SectionMastery } from "@ig/components/SectionMastery";
import { MasteryBadge } from "@ig/components/MasteryBadge";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Progress } from "@ig/components/ui/progress";
import { useContent } from "@ig/content/useContent";
import { localDateKey } from "@ig/lib/dates";
import { buildHeatmap, currentStreak } from "@ig/features/stats/lib/heatmap";
import { buildLookup } from "@ig/state/lookup";
import { computeMastery, DEFAULT_CONFIG } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import { useTodaySession } from "@ig/state/useTodaySession";

const LEVEL_CLASS = [
  "bg-muted",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/65",
  "bg-primary/90",
] as const;

export default function Dashboard() {
  const content = useContent();
  const attempts = useArena((s) => s.attempts);
  const session = useTodaySession();

  const dateKey = localDateKey();
  const lookup = useMemo(() => buildLookup(content), [content]);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);
  const streak = useMemo(() => currentStreak(attempts), [attempts]);
  const heatmap = useMemo(() => buildHeatmap(attempts, 13), [attempts]);

  const results = session ? Object.keys(session.results).length : 0;
  const total = session?.items.length ?? 0;

  const stuckList = useMemo(
    () =>
      [...mastery.values()]
        .filter((m) => m.min < 2 && m.date !== dateKey)
        .sort((a, b) => a.ts - b.ts)
        .slice(0, 8)
        .map((m) => lookup.get(m.qid))
        .filter((e) => e !== undefined),
    [mastery, dateKey, lookup],
  );

  const heatmapColumns: (typeof heatmap)[] = [];
  for (let i = 0; i < heatmap.length; i += 7) heatmapColumns.push(heatmap.slice(i, i + 7));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardDescription>
            {dateKey} · 连续练习 {streak} 天 · 按《十月冲刺计划》配比生成
          </CardDescription>
          <CardTitle>今日会话</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              进度 {results} / {total}
              {session ? "" : "（题库加载中…）"}
            </span>
            <span>
              配比 {DEFAULT_CONFIG.p0p1} 基础 + {DEFAULT_CONFIG.ai} AI + {DEFAULT_CONFIG.project}{" "}
              口述 + {DEFAULT_CONFIG.design} 设计 + {DEFAULT_CONFIG.retest} 卡点
            </span>
          </div>
          <Progress value={total ? (results / total) * 100 : 0} />
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/practice">
                {results > 0 ? "继续今日练习" : "开始今日练习"} <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/practice/sequential">
                <ListOrdered className="size-4" /> 顺序刷
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/practice/random">
                <Shuffle className="size-4" /> 随机刷
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/practice/wrong">
                <TriangleAlert className="size-4" /> 错题
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/practice/bookmarked">
                <Bookmark className="size-4" /> 收藏
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/interview">
                <Bot className="size-4" /> AI 面试官
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <RefreshCcw className="size-4 text-muted-foreground" /> 待复测卡点
              <Badge variant="secondary">{stuckList.length}</Badge>
            </CardTitle>
            <CardDescription>
              最近一次有维度低于 2 且非今天练的题，最久未练的已排进今日会话
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stuckList.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                暂无卡点。继续用「闭卷解释机制 + 举失败路径」的判据要求自己。
              </p>
            ) : (
              <ul className="space-y-1.5">
                {stuckList.map((entry, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-sm">
                    <Link
                      to={`/q/${encodeURIComponent(entry.question!.id)}`}
                      className="truncate hover:underline"
                    >
                      {entry.sectionTitle} / {entry.title}
                    </Link>
                    <MasteryBadge level="stuck" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              近两周热力
              <Link
                to="/stats"
                className="text-xs font-normal text-muted-foreground hover:underline"
              >
                完整统计 →
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-1">
              {heatmapColumns.map((col, i) => (
                <div key={i} className="flex flex-col gap-1">
                  {col.map((cell) => (
                    <div
                      key={cell.date}
                      title={`${cell.date}：${cell.count} 次`}
                      className={`size-3 rounded-sm ${LEVEL_CLASS[cell.level]}`}
                    />
                  ))}
                </div>
              ))}
            </div>
            <Button asChild variant="ghost" size="sm" className="mt-3 -ml-2">
              <Link to="/exams">
                <Layers className="size-4" /> 五套模拟卷可开考
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">掌握度总览</CardTitle>
          <CardDescription>
            口径：最近一次四维评分的最小值（2 掌握 / 1 模糊 / 0 卡点）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SectionMastery />
        </CardContent>
      </Card>
    </div>
  );
}
