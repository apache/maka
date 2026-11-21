import { useMemo, useState } from "react";
import { Link } from "@ig/router";
import { Bot, Search } from "lucide-react";
import { MasteryBadge, masteryLevel } from "@ig/components/MasteryBadge";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent } from "@ig/components/ui/card";
import { Input } from "@ig/components/ui/input";
import { useContent } from "@ig/content/useContent";
import { localDateKey } from "@ig/lib/dates";
import { buildLookup } from "@ig/state/lookup";
import { computeMastery, poolQuestionIds } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import { BackLink } from "@ig/features/practice/components/Runner";
import { searchQuestions } from "@ig/features/bank/lib/search";

type PoolTab = "stuck" | "wrong" | "bookmarked" | "all";

// AI 面试官入口：选一题开考 + 最近会话记录
export function InterviewIndex() {
  const content = useContent();
  const [tab, setTab] = useState<PoolTab>("stuck");
  const [query, setQuery] = useState("");
  const attempts = useArena((s) => s.attempts);
  const bookmarks = useArena((s) => s.bookmarks);
  const providers = useArena((s) => s.providers);
  const history = useArena((s) => s.interviewHistory);
  const lookup = useMemo(() => buildLookup(content), [content]);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);

  const active = providers.find((p) => p.id === useArenaDefaultId(providers));

  const ids = useMemo(() => {
    switch (tab) {
      case "stuck":
        return [...mastery.values()]
          .filter((m) => m.min < 2 && m.date !== localDateKey())
          .sort((a, b) => a.ts - b.ts)
          .slice(0, 20)
          .map((m) => m.qid);
      case "wrong":
        return poolQuestionIds(content.bank, "all", content.projectCards).filter(
          (qid) => (mastery.get(qid)?.min ?? 2) < 2,
        );
      case "bookmarked":
        return Object.keys(bookmarks);
      case "all":
        return poolQuestionIds(content.bank, "all", content.projectCards);
    }
  }, [tab, mastery, content, bookmarks]);

  const questions = useMemo(() => {
    const list = ids.map((qid) => lookup.get(qid)?.question).filter((q) => q !== undefined);
    return query.trim() ? searchQuestions(list, query) : list;
  }, [ids, lookup, query]);

  return (
    <div className="space-y-4">
      <BackLink to="/" label="仪表盘" />
      <div>
        <h1 className="text-lg font-semibold">AI 面试官</h1>
        <p className="text-sm text-muted-foreground">
          选一题开考：AI 沿用你文档里的追问链连续追问，结束后按四维 0–2 评分并计入掌握度。模型 Key
          只存本机浏览器。
        </p>
      </div>

      {providers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-4">
            <span className="text-sm text-muted-foreground">还没有配置模型服务商。</span>
            <Button asChild size="sm">
              <Link to="/settings">去设置页配置（DeepSeek / GLM / Kimi / Anthropic…）</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">
          当前模型：
          <Badge variant="secondary">
            {active?.label ?? providers[0].label} / {active?.model ?? providers[0].model}
          </Badge>
        </p>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜题目……"
          className="pl-9"
        />
      </div>

      <div className="flex gap-1">
        {(
          [
            ["stuck", "待复测卡点"],
            ["wrong", "错题"],
            ["bookmarked", "收藏"],
            ["all", "全库"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            variant={tab === key ? "default" : "ghost"}
            size="sm"
            onClick={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        {questions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            这个题池暂时是空的，换一个标签或先去练几轮。
          </p>
        )}
        {questions.map((q) => (
          <Link key={q.id} to={`/interview/${encodeURIComponent(q.id)}`} className="block">
            <Card className="py-3 transition-colors hover:border-primary/40">
              <CardContent className="flex items-center justify-between gap-2 px-4">
                <span className="text-sm font-medium">
                  <Bot className="mr-1.5 inline size-4 text-muted-foreground" />
                  {q.title}
                </span>
                <MasteryBadge level={masteryLevel(mastery.get(q.id)?.min)} />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {history.length > 0 && (
        <div className="space-y-2 pt-2">
          <h2 className="text-sm font-medium text-muted-foreground">最近 AI 面试记录</h2>
          {history.map((r) => {
            const entry = lookup.get(r.qid);
            return (
              <Link key={r.id} to={`/q/${encodeURIComponent(r.qid)}`} className="block">
                <Card className="py-3">
                  <CardContent className="px-4">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{entry ? entry.title : r.qid}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.rounds} 轮 · {r.providerLabel}
                      </span>
                    </div>
                    {r.comment && <p className="mt-1 text-xs text-muted-foreground">{r.comment}</p>}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useArenaDefaultId(providers: { id: string }[]): string | undefined {
  const id = useArena((s) => s.defaultProviderId);
  return providers.some((p) => p.id === id) ? id : undefined;
}
