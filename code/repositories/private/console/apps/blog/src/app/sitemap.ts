import type { MetadataRoute } from "next";
import { getAllArticles } from "@/server/articles";
import { getAllProblemSlugs } from "@/server/problems";

const BASE = "https://blog.local";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [articles, problems] = await Promise.all([getAllArticles(), getAllProblemSlugs()]);
  const staticRoutes = ["", "/articles", "/algo", "/growth", "/anime", "/skills", "/about"];

  return [
    ...staticRoutes.map((route) => ({ url: `${BASE}${route}` })),
    ...articles.map((a) => ({ url: `${BASE}/articles/${a.slug}`, lastModified: new Date(a.date) })),
    ...problems.map((slug) => ({ url: `${BASE}/algo/${slug}` })),
  ];
}
