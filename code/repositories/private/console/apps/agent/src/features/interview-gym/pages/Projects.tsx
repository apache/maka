import { Link, useParams } from "@ig/router";
import { ChevronLeft } from "lucide-react";
import { Markdown } from "@ig/components/Markdown";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Separator } from "@ig/components/ui/separator";
import { useContent } from "@ig/content/useContent";

// 项目区：P01–P07 是口述题池（来自项目地图），其余是只读参考文档
export function ProjectsIndex() {
  const content = useContent();
  const cardSlugs = new Set(content.projectCards.map((c) => c.slug));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">AI 项目与 Agent 工程</h1>
        <p className="text-sm text-muted-foreground">
          项目卡来自《AI项目地图》，规则：每场面试只深讲两个最有证据的案例。
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {content.projectCards.map((card) => (
          <Link key={card.code} to={`/projects/${encodeURIComponent(card.slug)}`}>
            <Card className="h-full transition-colors hover:border-primary/40">
              <CardHeader>
                <CardTitle className="text-base">
                  <Badge variant="secondary" className="mr-2">
                    {card.code}
                  </Badge>
                  {card.name}
                </CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
      <Separator />
      <h2 className="text-sm font-medium text-muted-foreground">参考文档</h2>
      <div className="flex flex-wrap gap-2">
        {content.projectDocs.map((doc) => (
          <Button
            key={doc.slug}
            asChild
            variant={cardSlugs.has(doc.slug) ? "outline" : "ghost"}
            size="sm"
          >
            <Link to={`/projects/${encodeURIComponent(doc.slug)}`}>{doc.title}</Link>
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ProjectDocPage() {
  const content = useContent();
  const { slug } = useParams() as { slug: string };
  const doc = content.projectDocs.find((d) => d.slug === slug);
  const body = slug ? content.projectBodies[slug] : undefined;

  if (!doc || body === undefined) {
    return (
      <div className="space-y-3">
        <BackToProjects />
        <p className="text-sm text-muted-foreground">找不到文档：{slug}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <BackToProjects />
      <article>
        <h1 className="mb-3 text-lg font-semibold">{doc.title}</h1>
        <Markdown>{body}</Markdown>
      </article>
    </div>
  );
}

function BackToProjects() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to="/projects">
        <ChevronLeft className="size-4" /> 项目
      </Link>
    </Button>
  );
}
