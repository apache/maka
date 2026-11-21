import { useState } from "react";
import { Link } from "@ig/router";
import { ChevronLeft } from "lucide-react";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardTitle } from "@ig/components/ui/card";
import { Progress } from "@ig/components/ui/progress";
import type { Attempt, Scores } from "@ig/content/types";
import { DIMENSIONS } from "@ig/content/types";
import type { LookupEntry } from "@ig/state/lookup";
import type { SessionItem } from "@ig/state/session";
import { ItemCard } from "./ItemCard";

export interface RunnerProps {
  title: string;
  subtitle?: string;
  header?: React.ReactNode; // 每题卡片上方附加内容（如考试计时）
  segmentLabel?: (index: number) => string | undefined; // 考试分段提示
  items: SessionItem[];
  lookup: Map<string, LookupEntry>;
  getProjectBody: (entry: LookupEntry) => string | undefined;
  onSave: (index: number, item: SessionItem, scores: Scores, note: string) => void;
  finishLabel?: string;
  finishTo?: string;
}

// 练习循环的通用外壳：进度 → 逐题（ItemCard）→ 完成页。
// 每日配比 / 四种刷题模式 / 模拟卷共用；结果如何落库由 onSave 决定
export function Runner({
  title,
  subtitle,
  header,
  segmentLabel,
  items,
  lookup,
  getProjectBody,
  onSave,
  finishLabel = "回到仪表盘",
  finishTo = "/",
}: RunnerProps) {
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<Record<number, Attempt>>({});

  const done = Object.keys(results).length;
  const total = items.length;

  if (total === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="text-sm text-muted-foreground">本轮暂无可练习题目，未生成练习成绩。</p>
          <Button asChild>
            <Link to={finishTo}>{finishLabel}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (index >= total) {
    const scored = items.map((item, i) => ({ item, attempt: results[i] })).filter((r) => r.attempt);
    const stillStuck = scored.filter(
      (r) => r.attempt && Math.min(...Object.values(r.attempt.scores)) < 2,
    );
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <CardTitle>{title} · 本轮完成</CardTitle>
          <p className="text-sm text-muted-foreground">
            完成 {scored.length}/{total} 题，其中 {stillStuck.length} 题仍有维度低于 2。
            按《每日完成判据》：能闭卷解释机制、项目取舍和失败路径才算完成。
          </p>
          <ul className="space-y-1.5 text-sm">
            {items.map((item, i) => {
              const entry = lookup.get(item.qid);
              const attempt = results[i];
              return (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className={attempt ? "" : "text-muted-foreground"}>
                    {entry ? `${entry.sectionTitle} / ${entry.title}` : item.qid}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {attempt ? DIMENSIONS.map((d) => `${attempt.scores[d.key]}`).join("·") : "未评"}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <Button asChild>
              <Link to={finishTo}>{finishLabel}</Link>
            </Button>
            <Button variant="outline" onClick={() => setIndex(0)}>
              回看题目
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const item = items[index];
  const entry = lookup.get(item.qid);
  if (!entry) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          这道题已不在当前资料中，历史记录仍保留：{item.qid}
        </p>
        <Button variant="outline" onClick={() => setIndex(index + 1)}>
          跳过并继续
        </Button>
        <BackLink to={finishTo} label={finishLabel} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{subtitle ?? title}</span>
        <span>
          第 {index + 1} / {total} 题 · 已评 {done} 题
        </span>
      </div>
      <Progress value={(index / total) * 100} />
      {header}
      {segmentLabel?.(index) && (
        <p className="text-xs font-medium text-muted-foreground">当前环节：{segmentLabel(index)}</p>
      )}
      <ItemCard
        key={index}
        item={item}
        entry={entry}
        lastAttempt={results[index]}
        projectBody={getProjectBody(entry)}
        onSave={(scores, note) => {
          onSave(index, item, scores, note);
          setResults((prev) => ({
            ...prev,
            [index]: { qid: item.qid, date: "", ts: Date.now(), kind: item.kind, scores, note },
          }));
          setIndex(index + 1);
        }}
        onSkip={() => setIndex(index + 1)}
        onBack={index > 0 ? () => setIndex(index - 1) : undefined}
      />
    </div>
  );
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to={to}>
        <ChevronLeft className="size-4" /> {label}
      </Link>
    </Button>
  );
}
