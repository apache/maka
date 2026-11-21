import { useMemo } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { MasteryBadge, masteryLevel } from "@ig/components/MasteryBadge";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ig/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { useContent } from "@ig/content/useContent";
import { DIMENSIONS, KIND_LABEL, minScore } from "@ig/content/types";
import type { ItemKind } from "@ig/content/types";
import { localDateKey } from "@ig/lib/dates";
import { attemptsToMarkdown, copyToClipboard, downloadMarkdown } from "@ig/state/export";
import { buildLookup } from "@ig/state/lookup";
import { useArena } from "@ig/state/store";

const KIND_BADGE: Record<ItemKind, "secondary" | "outline" | "default"> = {
  retest: "default",
  p0p1: "secondary",
  ai: "secondary",
  design: "secondary",
  project: "outline",
};

export default function Records() {
  const content = useContent();
  const attempts = useArena((s) => s.attempts);
  const clearAll = useArena((s) => s.clearAll);
  const lookup = useMemo(() => buildLookup(content), [content]);

  const sorted = [...attempts].sort((a, b) => b.ts - a.ts);
  const md = useMemo(() => attemptsToMarkdown(attempts, lookup), [attempts, lookup]);

  const onCopy = async () => {
    try {
      await copyToClipboard(md);
      toast.success("已复制 Markdown，可粘贴到 05-模拟面试记录.md");
    } catch {
      toast.error("复制失败，请改用下载");
    }
  };

  const onDownload = () => {
    downloadMarkdown(md, `自练场记录-${localDateKey()}.md`);
    toast.success("已下载 .md 文件");
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>练习记录导出</CardTitle>
          <CardDescription>
            共 {attempts.length} 条评分记录，存于浏览器 localStorage。按《模拟面试记录》的字段生成
            Markdown， 复制或下载后粘回仓库，保持「错误回流到题库」的习惯。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={onCopy}>复制 Markdown</Button>
          <Button variant="outline" onClick={onDownload}>
            <Download className="size-4" /> 下载 .md
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="ml-auto text-destructive hover:text-destructive">
                清空全部数据
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>清空全部练习数据？</AlertDialogTitle>
                <AlertDialogDescription>
                  将删除浏览器里的全部评分记录与每日会话（共 {attempts.length}{" "}
                  条），不影响仓库文档。导出后再操作更稳妥。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={clearAll}>确认清空</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          还没有练习记录。去「今日练习」开始第一轮主动回忆。
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((a, i) => {
            const entry = lookup.get(a.qid);
            return (
              <Card key={`${a.qid}:${a.ts}:${i}`}>
                <CardContent className="space-y-1.5 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {entry ? `${entry.sectionTitle} / ${entry.title}` : a.qid}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant={KIND_BADGE[a.kind]}>{KIND_LABEL[a.kind]}</Badge>
                      <MasteryBadge level={masteryLevel(minScore(a.scores))} />
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {a.date} · {DIMENSIONS.map((d) => `${d.label} ${a.scores[d.key]}`).join(" / ")}
                  </div>
                  {a.note.trim() && <p className="text-sm">{a.note}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
