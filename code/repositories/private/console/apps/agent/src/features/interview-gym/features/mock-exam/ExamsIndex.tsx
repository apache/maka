import { Link } from "@ig/router";
import { BookOpen, Timer } from "lucide-react";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { useContent } from "@ig/content/useContent";
import { EXAMS, buildExamItems } from "@ig/features/mock-exam/lib/exams";

// 模拟卷列表：可看原文档，也可开考（交互计时版）
export function ExamsIndex() {
  const content = useContent();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">综合模拟面试</h1>
        <p className="text-sm text-muted-foreground">
          先基础，再项目，随后设计与编码。每项 0–2 分：0 说不清 / 1 有概念缺证据 / 2
          机制、边界与验证完整。
        </p>
      </div>
      {EXAMS.map((exam) => {
        const doc = content.mocks.find((m) => m.slug === exam.slug);
        const totalMinutes = exam.segments.reduce((sum, s) => sum + s.minutes, 0);
        const totalCount = exam.segments.reduce((sum, s) => sum + s.count, 0);
        const hasQuestions =
          buildExamItems(exam, content.bank, content.projectCards).items.length > 0;
        return (
          <Card key={exam.slug}>
            <CardHeader>
              <CardTitle className="text-base">{exam.title}</CardTitle>
              <CardDescription>{exam.intro}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              {hasQuestions && (
                <Badge variant="secondary">
                  <Timer className="mr-1 size-3" /> {totalMinutes} 分钟
                </Badge>
              )}
              <Badge variant="secondary">{hasQuestions ? `${totalCount} 题` : "按需手练"}</Badge>
              <span className="flex-1" />
              {doc && (
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/exams/${encodeURIComponent(exam.slug)}/doc`}>
                    <BookOpen className="size-4" /> 看原卷
                  </Link>
                </Button>
              )}
              {hasQuestions ? (
                <Button asChild size="sm">
                  <Link to={`/exams/${encodeURIComponent(exam.slug)}`}>开考</Link>
                </Button>
              ) : (
                <Button disabled size="sm">
                  暂无可抽题
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
