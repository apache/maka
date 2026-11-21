import { useParams } from "@ig/router";
import { Markdown } from "@ig/components/Markdown";
import { Card, CardContent } from "@ig/components/ui/card";
import { useContent } from "@ig/content/useContent";
import { BackLink } from "@ig/features/practice/components/Runner";

// 模拟卷原文档（只读）
export function ExamDocPage() {
  const content = useContent();
  const { slug } = useParams() as { slug: string };
  const mock = content.mocks.find((m) => m.slug === decodeURIComponent(slug ?? ""));

  if (!mock) {
    return (
      <div className="space-y-3">
        <BackLink to="/exams" label="模拟卷" />
        <p className="text-sm text-muted-foreground">找不到试卷：{slug}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <BackLink to="/exams" label="模拟卷" />
      <Card>
        <CardContent className="pt-4">
          <Markdown>{mock.body}</Markdown>
        </CardContent>
      </Card>
    </div>
  );
}
