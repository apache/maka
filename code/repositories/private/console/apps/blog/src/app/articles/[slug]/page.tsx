import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@ggbdpq/console-ui";
import { Markdown } from "@ggbdpq/console-ui";
import { formatDate } from "@/components/article-card";
import { getAllArticles, getAdjacentArticles, getArticleBySlug } from "@/server/articles";

export async function generateStaticParams() {
  const all = await getAllArticles();
  return all.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) return { title: "文章走丢了" };
  return { title: article.title, description: article.excerpt };
}

export default async function ArticleDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) notFound();
  const { prev, next } = await getAdjacentArticles(slug);

  return (
    <article className="mx-auto max-w-3xl">
      <Link
        href="/articles"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 全部文章
      </Link>
      <header className="mt-6 mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{article.series}</Badge>
          {article.source ? <Badge variant="outline">来自 {article.source}</Badge> : null}
        </div>
        <h1 className="mt-3 text-3xl font-bold leading-snug">{article.title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {formatDate(article.date)} · {article.readingMinutes} 分钟阅读
          {article.views > 0 ? ` · ${article.views} 次阅读` : ""}
        </p>
      </header>
      <Markdown content={article.content} />
      <nav className="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2">
        {prev ? (
          <Link
            href={`/articles/${prev.slug}`}
            className="group rounded-lg border p-4 transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowLeft className="size-3" /> 上一篇
            </div>
            <div className="mt-1 text-sm font-medium group-hover:text-primary">{prev.title}</div>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            href={`/articles/${next.slug}`}
            className="group rounded-lg border p-4 text-right transition-colors hover:border-primary/40"
          >
            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              下一篇 <ArrowRight className="size-3" />
            </div>
            <div className="mt-1 text-sm font-medium group-hover:text-primary">{next.title}</div>
          </Link>
        ) : null}
      </nav>
    </article>
  );
}
