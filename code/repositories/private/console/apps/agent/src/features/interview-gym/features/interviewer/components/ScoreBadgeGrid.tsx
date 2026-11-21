import { Badge } from "@ig/components/ui/badge";
import type { Scores } from "@ig/content/types";
import { DIMENSIONS } from "@ig/content/types";

const CLASS: Record<0 | 1 | 2, string> = {
  0: "bg-red-500/15 text-red-700 dark:text-red-400",
  1: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  2: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

// 四维评分一览（AI 评分卡 / 复盘页共用）
export function ScoreBadgeGrid({ scores }: { scores: Scores }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DIMENSIONS.map((d) => (
        <Badge key={d.key} className={CLASS[scores[d.key]]}>
          {d.label} {scores[d.key]}
        </Badge>
      ))}
    </div>
  );
}
