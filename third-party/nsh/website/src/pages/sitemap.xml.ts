import type { APIRoute } from 'astro';
import { homeCopy } from '../lib/home';
import { machineLocales } from '../lib/locales';
import { pages } from '../lib/sections';
import { getShowcaseApps } from '../lib/showcases';
import { SITE_URL, url } from '../lib/site';

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const GET: APIRoute = async () => {
  const en = await pages('en');
  const zh = await pages('zh-CN');
  const abs = (href: string) => new URL(href, SITE_URL).href;

  // Each entry lists its translations, so search engines pair the locales.
  const entries: { href: string; en?: string; zh?: string }[] = [];
  for (const [e, z] of [[url(''), url('zh-CN')], [url('playground'), url('zh-CN/playground')], [url('gallery'), url('zh-CN/gallery')], [url('apps'), url('zh-CN/apps')], [url('directory'), url('zh-CN/directory')], [url('releases'), url('zh-CN/releases')], [url('brand'), url('zh-CN/brand')], ...(await getShowcaseApps()).filter((app) => app.hasReadme).map((app) => [url(`apps/${app.id}`), url(`zh-CN/apps/${app.id}`)])]) {
    entries.push({ href: e, en: e, zh: z }, { href: z, en: e, zh: z });
  }
  for (const page of [...en, ...zh]) {
    const enPage = en.find((p) => p.section === page.section && p.slug === page.slug);
    const zhPage = zh.find((p) => p.section === page.section && p.slug === page.slug);
    entries.push({ href: page.href, en: enPage?.href, zh: zhPage?.href });
  }

  // Machine translations are listed bare; a page without one is not indexed.
  for (const { code } of machineLocales) {
    if (homeCopy(code).translated) entries.push({ href: url(code) });
    for (const page of await pages(code)) if (page.translated) entries.push({ href: page.href });
  }

  const urls = entries
    .map(({ href, en: e, zh: z }) => {
      const links = e && z
        ? `<xhtml:link rel="alternate" hreflang="en" href="${escapeXml(abs(e))}"/><xhtml:link rel="alternate" hreflang="zh-CN" href="${escapeXml(abs(z))}"/><xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(abs(e))}"/>`
        : '';
      return `<url><loc>${escapeXml(abs(href))}</loc>${links}</url>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
