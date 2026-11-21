import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import { articleSchema, type Article, type Series } from "@/schemas/content";
import { parseFrontmatter } from "@/lib/frontmatter";
import { articles as inlineArticles, seriesList as inlineSeries } from "@/data/articles";

// 文章域唯一入口：TS 内联源（ggbdpq-site 原生 8 篇）+ content/articles/*.md（迁移集）双源合一。
// 页面与 RSS 只经这里取数，不感知来源差异。

const CONTENT_DIR = path.join(process.cwd(), "content", "articles");

/** md 文章正文估算阅读时长：中文约每分钟 450 字 */
function estimateReadingMinutes(body: string): number {
  return Math.max(1, Math.round(body.length / 450));
}

async function loadMdArticles(): Promise<Article[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(CONTENT_DIR);
  } catch {
    return [];
  }
  const loaded = await Promise.all(
    entries
      .filter((f) => f.endsWith(".md"))
      .map(async (file) => {
        const raw = await fs.readFile(path.join(CONTENT_DIR, file), "utf8");
        const { data, body } = parseFrontmatter(raw);
        // 脏数据 fail-fast：slug/date/series/title 缺一不可
        return articleSchema.parse({
          slug: data.slug,
          title: data.title,
          series: data.series,
          date: data.date,
          excerpt: data.excerpt ?? "",
          tags: data.source ? [data.source] : [],
          readingMinutes: estimateReadingMinutes(body),
          views: 0,
          content: body,
          source: data.source,
        });
      }),
  );
  return loaded;
}

const loadAll = cache(async (): Promise<Article[]> => {
  const merged = [...inlineArticles, ...(await loadMdArticles())];
  // 日期降序（列表展示顺序稳定）；slug 冲突即数据事故，直接抛错
  const bySlug = new Map<string, Article>();
  for (const article of merged) {
    if (bySlug.has(article.slug)) throw new Error(`文章 slug 冲突：${article.slug}`);
    bySlug.set(article.slug, article);
  }
  return [...bySlug.values()].sort((a, b) => b.date.localeCompare(a.date));
});

export const getAllArticles = cache(async (): Promise<Article[]> => loadAll());

export const getArticleBySlug = cache(async (slug: string): Promise<Article | undefined> => {
  const all = await getAllArticles();
  return all.find((a) => a.slug === slug);
});

/** 系列清单：内联系列 + md 中出现的新系列（按最早文章日期排序） */
export const getSeriesList = cache(async (): Promise<Series[]> => {
  const all = await getAllArticles();
  const known = new Set(inlineSeries.map((s) => s.name));
  const extra = new Map<string, Series>();
  for (const article of all) {
    if (!known.has(article.series) && !extra.has(article.series)) {
      extra.set(article.series, {
        name: article.series,
        description: article.excerpt,
      });
    }
  }
  return [...inlineSeries, ...extra.values()];
});

export const getArticlesBySeries = cache(async (series: string): Promise<Article[]> => {
  const all = await getAllArticles();
  return all.filter((a) => a.series === series);
});

/** 上下篇：按日期升序视角的 prev / next */
export const getAdjacentArticles = cache(async (slug: string) => {
  const sorted = [...(await getAllArticles())].sort((a, b) => a.date.localeCompare(b.date));
  const idx = sorted.findIndex((a) => a.slug === slug);
  if (idx === -1) return { prev: undefined, next: undefined };
  return { prev: sorted[idx - 1], next: sorted[idx + 1] };
});
