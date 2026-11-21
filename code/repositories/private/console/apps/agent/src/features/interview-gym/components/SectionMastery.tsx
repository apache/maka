import { useMemo } from "react";
import { Link } from "@ig/router";
import { masteryLevel } from "@ig/components/MasteryBadge";
import { Progress } from "@ig/components/ui/progress";
import { useContent } from "@ig/content/useContent";
import { computeMastery } from "@ig/state/session";
import { useArena } from "@ig/state/store";

// 分区掌握度列表：Dashboard 与统计页共用
export function SectionMastery() {
  const content = useContent();
  const attempts = useArena((s) => s.attempts);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);

  const sections = content.bank.map((section) => {
    const levels = section.questions.map((q) => masteryLevel(mastery.get(q.id)?.min));
    return {
      id: section.id,
      title: section.title,
      candidate: section.candidate,
      count: section.questions.length,
      mastered: levels.filter((l) => l === "mastered").length,
      stuck: levels.filter((l) => l === "stuck").length,
      shaky: levels.filter((l) => l === "shaky").length,
    };
  });

  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <div key={s.id} className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Link
                to={`/bank/${encodeURIComponent(s.id)}`}
                className="font-medium hover:underline"
              >
                {s.title}
              </Link>
              {s.candidate && <span className="text-xs text-muted-foreground">候选</span>}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {s.mastered > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400">掌握 {s.mastered}</span>
              )}
              {s.shaky > 0 && (
                <span className="text-amber-600 dark:text-amber-400">模糊 {s.shaky}</span>
              )}
              {s.stuck > 0 && (
                <span className="text-red-600 dark:text-red-400">卡点 {s.stuck}</span>
              )}
              <span>
                {s.mastered}/{s.count}
              </span>
            </span>
          </div>
          <Progress value={s.count ? (s.mastered / s.count) * 100 : 0} />
        </div>
      ))}
    </div>
  );
}

export function OverallMastery() {
  const content = useContent();
  const attempts = useArena((s) => s.attempts);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);
  const all = content.bank.flatMap((s) => s.questions);
  const levels = all.map((q) => masteryLevel(mastery.get(q.id)?.min));
  const counts = {
    mastered: levels.filter((l) => l === "mastered").length,
    shaky: levels.filter((l) => l === "shaky").length,
    stuck: levels.filter((l) => l === "stuck").length,
    untested: levels.filter((l) => l === "untested").length,
  };
  const cards: Array<[string, number, string]> = [
    ["已掌握", counts.mastered, "text-emerald-600 dark:text-emerald-400"],
    ["模糊", counts.shaky, "text-amber-600 dark:text-amber-400"],
    ["卡点", counts.stuck, "text-red-600 dark:text-red-400"],
    ["未测", counts.untested, "text-muted-foreground"],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cards.map(([label, n, cls]) => (
        <div key={label} className="rounded-lg border p-3">
          <div className={`text-xl font-semibold ${cls}`}>{n}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      ))}
    </div>
  );
}
