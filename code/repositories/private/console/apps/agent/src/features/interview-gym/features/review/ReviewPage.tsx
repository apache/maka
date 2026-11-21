import { useMemo, useState } from "react";
import { Link } from "@ig/router";
import { BookmarkCheck, History } from "lucide-react";
import { MasteryBadge, masteryLevel } from "@ig/components/MasteryBadge";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent } from "@ig/components/ui/card";
import { useContent } from "@ig/content/useContent";
import { DIMENSIONS } from "@ig/content/types";
import { buildLookup } from "@ig/state/lookup";
import { computeMastery } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import { BackLink } from "@ig/features/practice/components/Runner";

type Tab = "wrong" | "bookmarked";

// 复盘域：错题本（派生自最近评分）+ 收藏夹
export function ReviewPage() {
  const content = useContent();
  const [tab, setTab] = useState<Tab>("wrong");
  const attempts = useArena((s) => s.attempts);
  const bookmarks = useArena((s) => s.bookmarks);
  const lookup = useMemo(() => buildLookup(content), [content]);
  const mastery = useMemo(() => computeMastery(attempts), [attempts]);

  const wrongList = [...mastery.values()].filter((m) => m.min < 2).sort((a, b) => a.ts - b.ts);
  const bookmarkList = Object.entries(bookmarks).sort(([, a], [, b]) => b - a);

  return (
    <div className="space-y-4">
      <BackLink to="/" label="仪表盘" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">复盘</h1>
        <div className="flex gap-1">
          <Button
            variant={tab === "wrong" ? "default" : "ghost"}
            size="sm"
            onClick={() => setTab("wrong")}
          >
            错题本 {wrongList.length}
          </Button>
          <Button
            variant={tab === "bookmarked" ? "default" : "ghost"}
            size="sm"
            onClick={() => setTab("bookmarked")}
          >
            收藏夹 {bookmarkList.length}
          </Button>
        </div>
      </div>

      {tab === "wrong" &&
        (wrongList.length === 0 ? (
          <EmptyState text="暂无错题。评分有维度低于 2 的题会自动进这里。" />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">最久没练的排在最前；也可以直接</p>
            <Button asChild size="sm" variant="outline">
              <Link to="/practice/wrong">开刷错题模式</Link>
            </Button>
            {wrongList.map((m) => {
              const entry = lookup.get(m.qid);
              if (!entry) return null;
              const last = attempts.find((a) => a.qid === m.qid && a.ts === m.ts);
              return (
                <Link key={m.qid} to={`/q/${encodeURIComponent(m.qid)}`} className="block">
                  <Card className="py-3 transition-colors hover:border-primary/40">
                    <CardContent className="space-y-1 px-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {entry.sectionTitle} / {entry.title}
                        </span>
                        <MasteryBadge level={masteryLevel(m.min)} />
                      </div>
                      {last && (
                        <p className="text-xs text-muted-foreground">
                          {last.date} ·{" "}
                          {DIMENSIONS.map((d) => `${d.label} ${last.scores[d.key]}`).join(" / ")}
                          {last.note.trim() ? ` · ${last.note.trim()}` : ""}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        ))}

      {tab === "bookmarked" &&
        (bookmarkList.length === 0 ? (
          <EmptyState text="暂无收藏。在题目详情页或练习卡右上角点收藏图标即可加入。" />
        ) : (
          <div className="space-y-2">
            {bookmarkList.map(([qid]) => {
              const entry = lookup.get(qid);
              if (!entry) return null;
              return (
                <Link key={qid} to={`/q/${encodeURIComponent(qid)}`} className="block">
                  <Card className="py-3 transition-colors hover:border-primary/40">
                    <CardContent className="flex items-center justify-between gap-2 px-4">
                      <span className="text-sm font-medium">
                        <BookmarkCheck className="mr-1.5 inline size-4 text-primary" />
                        {entry.sectionTitle} / {entry.title}
                      </span>
                      <MasteryBadge level={masteryLevel(mastery.get(qid)?.min)} />
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-2 py-8">
        <Badge variant="secondary" className="mb-1">
          <History className="mr-1 size-3" /> 空空如也
        </Badge>
        <p className="text-sm text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
}
