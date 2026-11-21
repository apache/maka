import Link from "next/link";
import type { Article } from "@/schemas/content";

export function formatDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
}

export function ArticleCard({ article }: { article: Article }) {
  return (
    <Link
      href={`/articles/${article.slug}`}
      className="group block rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-accent/50"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{formatDate(article.date)}</span>
        <span>·</span>
        <span>{article.readingMinutes} 分钟</span>
        {article.source ? (
          <>
            <span>·</span>
            <span>来自 {article.source}</span>
          </>
        ) : null}
      </div>
      <h3 className="mt-1.5 font-medium leading-6 group-hover:text-primary">{article.title}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{article.excerpt}</p>
    </Link>
  );
}
