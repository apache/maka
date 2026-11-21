import { Badge } from "@ig/components/ui/badge";

// 掌握度口径：最近一次评分四维最小值 —— 2 全绿=掌握，1=模糊，0=卡点，没练过=未测
export type MasteryLevel = "untested" | "stuck" | "shaky" | "mastered";

export function masteryLevel(min: 0 | 1 | 2 | undefined): MasteryLevel {
  if (min === undefined) return "untested";
  if (min === 2) return "mastered";
  if (min === 1) return "shaky";
  return "stuck";
}

const STYLES: Record<MasteryLevel, { label: string; className: string }> = {
  untested: { label: "未测", className: "bg-secondary text-secondary-foreground" },
  stuck: { label: "卡点", className: "bg-red-500/15 text-red-700 dark:text-red-400" },
  shaky: { label: "模糊", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  mastered: {
    label: "掌握",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
};

export function MasteryBadge({ level }: { level: MasteryLevel }) {
  const style = STYLES[level];
  return <Badge className={style.className}>{style.label}</Badge>;
}
