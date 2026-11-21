import { getAllArticles } from "@/server/articles";

// RSS 2.0：文章域全量输出
export async function GET() {
  const articles = await getAllArticles();
  const items = articles
    .map(
      (a) => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>https://blog.local/articles/${a.slug}</link>
      <guid isPermaLink="true">https://blog.local/articles/${a.slug}</guid>
      <pubDate>${new Date(a.date).toUTCString()}</pubDate>
      <description>${escapeXml(a.excerpt)}</description>
      <category>${escapeXml(a.series)}</category>
    </item>`,
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>ggbdpq 的博客</title>
    <link>https://blog.local</link>
    <description>日拱一卒，功不唐捐</description>
    <language>zh-CN</language>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
