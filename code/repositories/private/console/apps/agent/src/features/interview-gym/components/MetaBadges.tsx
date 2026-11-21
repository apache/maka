import { Badge } from "@ig/components/ui/badge";
import type { Question } from "@ig/content/types";

const DIFFICULTY_CLASS: Record<string, string> = {
  简单: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  中等: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  困难: "bg-red-500/15 text-red-700 dark:text-red-400",
};

export function MetaBadges({
  question,
  compact = false,
}: {
  question: Question;
  compact?: boolean;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {question.difficulty && (
        <Badge variant="outline" className={DIFFICULTY_CLASS[question.difficulty] ?? ""}>
          {question.difficulty}
        </Badge>
      )}
      {question.frequency && (
        <Badge
          variant="outline"
          className={
            question.frequency === "高" ? "border-red-500/40 text-red-600 dark:text-red-400" : ""
          }
        >
          {question.frequency === "高" ? "高频" : `频次${question.frequency}`}
        </Badge>
      )}
      {!compact &&
        question.tags.map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
    </span>
  );
}
