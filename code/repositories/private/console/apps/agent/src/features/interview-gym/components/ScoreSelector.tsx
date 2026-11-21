import { Button } from "@ig/components/ui/button";
import type { Score } from "@ig/content/types";

const SCORE_HINT: Record<Score, string> = {
  0: "说不清",
  1: "有概念缺证据",
  2: "机制、边界与验证完整",
};

// 单维度 0/1/2 评分，口径与《综合模拟面试》一致
export function ScoreSelector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Score;
  onChange: (v: Score) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{SCORE_HINT[value]}</div>
      </div>
      <div className="flex gap-1">
        {([0, 1, 2] as const).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={value === v ? "default" : "outline"}
            className="w-9"
            onClick={() => onChange(v)}
          >
            {v}
          </Button>
        ))}
      </div>
    </div>
  );
}
