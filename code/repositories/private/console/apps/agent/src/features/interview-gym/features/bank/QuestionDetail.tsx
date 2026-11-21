import { useMemo } from "react";
import { Link, useParams } from "@ig/router";
import { Bookmark, BookmarkCheck, Bot, History } from "lucide-react";
import { Markdown } from "@ig/components/Markdown";
import { MasteryBadge, masteryLevel } from "@ig/components/MasteryBadge";
import { MetaBadges } from "@ig/components/MetaBadges";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Textarea } from "@ig/components/ui/textarea";
import { useContent } from "@ig/content/useContent";
import { DIMENSIONS } from "@ig/content/types";
import { buildLookup } from "@ig/state/lookup";
import { computeMastery } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import { BackLink } from "@ig/features/practice/components/Runner";

// 题目详情：要点 / 元数据 / 个人笔记 / 收藏 / 历史评分 / AI 追问入口
export function QuestionDetail() {
  const content = useContent();
  const { qid } = useParams() as { qid: string };
  const decoded = qid ? decodeURIComponent(qid) : "";
  const attempts = useArena((s) => s.attempts);
  const notes = useArena((s) => s.notes);
  const setNote = useArena((s) => s.setNote);
  const bookmarks = useArena((s) => s.bookmarks);
  const toggleBookmark = useArena((s) => s.toggleBookmark);

  const lookup = useMemo(() => buildLookup(content), [content]);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);

  const entry = lookup.get(decoded);
  const question = entry?.question;

  if (!entry || !question) {
    return (
      <div className="space-y-3">
        <BackLink to="/bank" label="题库" />
        <p className="text-sm text-muted-foreground">找不到题目：{decoded}</p>
      </div>
    );
  }

  const latest = mastery.get(decoded);
  const history = attempts.filter((a) => a.qid === decoded).sort((a, b) => b.ts - a.ts);
  const bookmarked = Boolean(bookmarks[decoded]);
  const section = content.bank.find((s) => s.id === question.sectionId);

  return (
    <div className="space-y-4">
      <BackLink
        to={section ? `/bank/${encodeURIComponent(section.id)}` : "/bank"}
        label={section?.title ?? "题库"}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{entry.sectionTitle}</Badge>
            {section?.candidate && (
              <Badge variant="outline" className="border-dashed">
                候选
              </Badge>
            )}
            <MetaBadges question={question} />
            <MasteryBadge level={masteryLevel(latest?.min)} />
          </div>
          <CardTitle className="text-xl">{question.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {question.points ? (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">回答要点</div>
              <Markdown>{question.points}</Markdown>
            </div>
          ) : (
            <Markdown>{question.bodyMd}</Markdown>
          )}
          {question.acceptance && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">验收</div>
              <Markdown>{question.acceptance}</Markdown>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to={`/interview/${encodeURIComponent(decoded)}`}>
                <Bot className="size-4" /> AI 面试官追问这题
              </Link>
            </Button>
            <Button variant="outline" onClick={() => toggleBookmark(decoded)}>
              {bookmarked ? (
                <BookmarkCheck className="size-4 text-primary" />
              ) : (
                <Bookmark className="size-4" />
              )}
              {bookmarked ? "已收藏" : "收藏"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">个人笔记</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={notes[decoded] ?? ""}
            onChange={(e) => setNote(decoded, e.target.value)}
            placeholder="自己的理解、易错点、证据入口、相关项目……即时保存。"
            rows={4}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="size-4 text-muted-foreground" /> 评分历史（{history.length}）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没练过这题。</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {history.map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    {a.date}
                    {a.note.trim() ? ` · ${a.note.trim()}` : ""}
                  </span>
                  <span className="text-xs">
                    {DIMENSIONS.map((d) => `${d.label} ${a.scores[d.key]}`).join(" / ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
