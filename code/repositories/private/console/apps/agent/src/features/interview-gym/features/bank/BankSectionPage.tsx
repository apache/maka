import { useMemo, useState } from "react";
import { Link, useParams } from "@ig/router";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "@ig/components/Markdown";
import { MasteryBadge, masteryLevel } from "@ig/components/MasteryBadge";
import { MetaBadges } from "@ig/components/MetaBadges";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ig/components/ui/card";
import { useContent } from "@ig/content/useContent";
import { DIMENSIONS } from "@ig/content/types";
import type { Question } from "@ig/content/types";
import { computeMastery } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import { BackLink } from "@ig/features/practice/components/Runner";

// 分区页：题目列表，行内展开要点；候选区整页带提示
export function BankSectionPage() {
  const content = useContent();
  const { sectionId } = useParams() as { sectionId: string };
  const attempts = useArena((s) => s.attempts);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const section = content.bank.find((s) => s.id === sectionId);
  if (!section) {
    return (
      <div className="space-y-3">
        <BackLink to="/bank" label="题库" />
        <p className="text-sm text-muted-foreground">找不到分区：{sectionId}</p>
      </div>
    );
  }

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <BackLink to="/bank" label="题库" />
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">{section.title}</h1>
        {section.candidate && (
          <Badge variant="outline" className="border-dashed">
            候选 · 待审核
          </Badge>
        )}
      </div>
      {section.intro && <p className="text-sm text-muted-foreground">{section.intro}</p>}

      {section.notes.map((note) => (
        <Card key={note.title}>
          <CardHeader>
            <CardTitle className="text-sm">{note.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown>{note.bodyMd}</Markdown>
          </CardContent>
        </Card>
      ))}

      <div className="space-y-2">
        {section.questions.map((q, i) => {
          const latest = mastery.get(q.id);
          const lastAttempt = latest
            ? attempts.find((a) => a.qid === q.id && a.ts === latest.ts)
            : undefined;
          const open = expanded.has(q.id);
          return (
            <Card key={q.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                onClick={() => toggle(q.id)}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className="text-xs text-muted-foreground">{i + 1}</span>
                  {q.title}
                </span>
                <span className="flex items-center gap-1.5">
                  <MetaBadges question={q} compact />
                  <MasteryBadge level={masteryLevel(latest?.min)} />
                  {open ? (
                    <ChevronUp className="size-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="size-4 text-muted-foreground" />
                  )}
                </span>
              </button>
              {open && (
                <CardContent className="space-y-3 border-t pt-3">
                  <QuestionBody question={q} />
                  {lastAttempt && (
                    <p className="text-xs text-muted-foreground">
                      最近一次（{lastAttempt.date}）：
                      {DIMENSIONS.map((d) => `${d.label} ${lastAttempt.scores[d.key]}`).join(" / ")}
                    </p>
                  )}
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/q/${encodeURIComponent(q.id)}`}>详情 / 笔记 / AI 追问</Link>
                  </Button>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function QuestionBody({ question }: { question: Question }) {
  if (question.points || question.acceptance) {
    return (
      <div className="space-y-2">
        {question.points && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">回答要点</div>
            <Markdown>{question.points}</Markdown>
          </div>
        )}
        {question.acceptance && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">验收</div>
            <Markdown>{question.acceptance}</Markdown>
          </div>
        )}
      </div>
    );
  }
  return <Markdown>{question.bodyMd}</Markdown>;
}
