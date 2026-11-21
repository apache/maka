import { useState } from "react";
import { Link } from "@ig/router";
import { Bookmark, BookmarkCheck, BookOpenText, ChevronLeft, ChevronRight } from "lucide-react";
import { Markdown } from "@ig/components/Markdown";
import { ScoreSelector } from "@ig/components/ScoreSelector";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Separator } from "@ig/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@ig/components/ui/sheet";
import { ScrollArea } from "@ig/components/ui/scroll-area";
import { Textarea } from "@ig/components/ui/textarea";
import type { Attempt, Scores } from "@ig/content/types";
import { DIMENSIONS } from "@ig/content/types";
import type { LookupEntry } from "@ig/state/lookup";
import type { SessionItem } from "@ig/state/session";
import { useArena } from "@ig/state/store";

const ZERO: Scores = { factual: 0, mechanism: 0, failure: 0, expression: 0 };

// 单题练习卡：遮住要点 → 口述 → 揭示 → 四维评分 → 备注
// key=<index> 重挂载使用，题与题的状态天然隔离
export function ItemCard({
  item,
  entry,
  lastAttempt,
  projectBody,
  onSave,
  onSkip,
  onBack,
}: {
  item: SessionItem;
  entry: LookupEntry;
  lastAttempt: Attempt | undefined;
  projectBody: string | undefined;
  onSave: (scores: Scores, note: string) => void;
  onSkip: () => void;
  onBack: (() => void) | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  const [scores, setScores] = useState<Scores>(lastAttempt?.scores ?? ZERO);
  const [note, setNote] = useState("");
  const bookmarks = useArena((s) => s.bookmarks);
  const toggleBookmark = useArena((s) => s.toggleBookmark);
  const question = entry.question;
  const bookmarked = Boolean(bookmarks[item.qid]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {entry.question ? (
              <Link to={`/q/${encodeURIComponent(item.qid)}`} className="hover:underline">
                {entry.sectionTitle}
              </Link>
            ) : (
              entry.sectionTitle
            )}
          </Badge>
          {question?.difficulty && <Badge variant="outline">{question.difficulty}</Badge>}
          {question?.frequency === "高" && (
            <Badge className="bg-red-500/15 text-red-700 dark:text-red-400">高频</Badge>
          )}
          {item.kind === "retest" && lastAttempt && (
            <span className="text-xs text-muted-foreground">
              上次：{DIMENSIONS.map((d) => `${d.label}${lastAttempt.scores[d.key]}`).join(" / ")}
            </span>
          )}
          {question && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto size-7"
              aria-label={bookmarked ? "取消收藏" : "收藏本题"}
              onClick={() => toggleBookmark(item.qid)}
            >
              {bookmarked ? (
                <BookmarkCheck className="size-4 text-primary" />
              ) : (
                <Bookmark className="size-4" />
              )}
            </Button>
          )}
        </div>
        <CardTitle className="text-lg">{entry.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!revealed ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              先不看要点：用自己的话解释机制，举一个失败路径，需要项目时说清本人职责与证据入口。说完再揭示。
            </p>
            {projectBody !== undefined && <ProjectDocSheet name={entry.title} body={projectBody} />}
            <Button onClick={() => setRevealed(true)}>
              <BookOpenText className="size-4" /> 口述完毕，揭示回答要点
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {question && (question.points || question.acceptance) ? (
              <>
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
              </>
            ) : (
              <Markdown>{question ? question.bodyMd : (projectBody ?? "")}</Markdown>
            )}
            {projectBody !== undefined && <ProjectDocSheet name={entry.title} body={projectBody} />}
          </div>
        )}

        <Separator />

        <div className="space-y-2">
          {DIMENSIONS.map((dim) => (
            <ScoreSelector
              key={dim.key}
              label={dim.label}
              value={scores[dim.key]}
              onChange={(v) => setScores((prev) => ({ ...prev, [dim.key]: v }))}
            />
          ))}
        </div>
        <Textarea
          placeholder="备注（可选）：卡点、遗漏的证据、下次复测注意什么。会进入导出记录。"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" disabled={!onBack} onClick={onBack}>
            <ChevronLeft className="size-4" /> 上一题
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onSkip}>
              跳过 <ChevronRight className="size-4" />
            </Button>
            <Button onClick={() => onSave(scores, note)}>
              {lastAttempt ? "更新评分并继续" : "保存评分并继续"}{" "}
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectDocSheet({ name, body }: { name: string; body: string }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">
          <BookOpenText className="size-4" />
          查看项目文档
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full max-w-md p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>{name}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-4rem)]">
          <div className="px-4 py-3">
            <Markdown>{body}</Markdown>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
