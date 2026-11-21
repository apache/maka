import type { Metadata } from "next";
import { Badge } from "@ggbdpq/console-ui";
import { ArticleCard } from "@/components/article-card";
import { getAllArticles, getSeriesList } from "@/server/articles";

export const metadata: Metadata = {
  title: "文章",
  description: "技术文章与 AI 工程实践笔记",
};

export default async function ArticlesPage() {
  const [series, all] = await Promise.all([getSeriesList(), getAllArticles()]);

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">文章</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {all.length} 篇 · {series.length} 个系列
        </p>
      </header>
      <div className="space-y-10">
        {series.map((s) => {
          const items = all.filter((a) => a.series === s.name);
          if (items.length === 0) return null;
          return (
            <section key={s.name}>
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="text-lg font-semibold">{s.name}</h2>
                <Badge variant="secondary">{items.length}</Badge>
              </div>
              <p className="mb-4 text-sm text-muted-foreground">{s.description}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {items.map((article) => (
                  <ArticleCard key={article.slug} article={article} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
