import { useMemo, useState } from "react";
import { Link } from "@ig/router";
import { Search, X } from "lucide-react";
import { MasteryBadge, masteryLevel } from "@ig/components/MasteryBadge";
import { MetaBadges } from "@ig/components/MetaBadges";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Input } from "@ig/components/ui/input";
import { useContent } from "@ig/content/useContent";
import { computeMastery } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import { collectTags, searchQuestions } from "./lib/search";

// 题库首页：全文搜索 + 标签筛选 + 分区导航（含候选区）
export function BankIndex() {
  const content = useContent();
  const attempts = useArena((s) => s.attempts);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const allQuestions = useMemo(() => content.bank.flatMap((s) => s.questions), [content]);
  const tags = useMemo(() => collectTags(content.bank).slice(0, 24), [content]);

  const results = useMemo(() => {
    let list = query.trim() ? searchQuestions(allQuestions, query) : allQuestions;
    if (activeTag) list = list.filter((q) => q.tags.includes(activeTag));
    return list;
  }, [allQuestions, query, activeTag]);

  const searching = Boolean(query.trim()) || Boolean(activeTag);
  const mainBank = content.bank.filter((s) => !s.candidate);
  const candidateBank = content.bank.filter((s) => s.candidate);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">题库</h1>
        <p className="text-sm text-muted-foreground">
          内容同步自 interview 仓库 <code className="text-xs">03-题库与系统设计/</code>，共{" "}
          {allQuestions.length} 题；候选区题目审核合入后才进刷题池。
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索题目标题、标签或要点……"
          className="pl-9"
        />
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map(({ tag, count }) => (
            <Badge
              key={tag}
              variant={activeTag === tag ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
            >
              {tag} <span className="ml-1 opacity-60">{count}</span>
            </Badge>
          ))}
        </div>
      )}

      {searching ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              匹配 {results.length} 题{activeTag ? ` · 标签「${activeTag}」` : ""}
            </span>
            {(query || activeTag) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setActiveTag(null);
                }}
              >
                <X className="size-4" /> 清除筛选
              </Button>
            )}
          </div>
          {results.map((q) => (
            <Link key={q.id} to={`/q/${encodeURIComponent(q.id)}`} className="block">
              <Card className="py-3 transition-colors hover:border-primary/40">
                <CardContent className="flex items-center justify-between gap-2 px-4">
                  <span className="text-sm font-medium">{q.title}</span>
                  <span className="flex items-center gap-1.5">
                    <MetaBadges question={q} compact />
                    <MasteryBadge level={masteryLevel(mastery.get(q.id)?.min)} />
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <>
          {mainBank.map((section) => {
            const levels = section.questions.map((q) => masteryLevel(mastery.get(q.id)?.min));
            const mastered = levels.filter((l) => l === "mastered").length;
            return (
              <Link
                key={section.id}
                to={`/bank/${encodeURIComponent(section.id)}`}
                className="block"
              >
                <Card className="transition-colors hover:border-primary/40">
                  <CardHeader>
                    <CardTitle className="text-base">{section.title}</CardTitle>
                    <CardDescription>
                      {section.questions.length} 题 · 已掌握 {mastered}
                      {section.notes.length > 0 && ` · 附注 ${section.notes.length} 篇`}
                    </CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
          {candidateBank.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">候选题库</h2>
                <Badge variant="outline">待审核</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                AI 扩题先落这里，浏览与检索可用；把文件移出候选目录即视为合入。
              </p>
              {candidateBank.map((section) => (
                <Link
                  key={section.id}
                  to={`/bank/${encodeURIComponent(section.id)}`}
                  className="block"
                >
                  <Card className="border-dashed transition-colors hover:border-primary/40">
                    <CardHeader>
                      <CardTitle className="text-base">{section.title}</CardTitle>
                      <CardDescription>{section.questions.length} 题 · 候选</CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
