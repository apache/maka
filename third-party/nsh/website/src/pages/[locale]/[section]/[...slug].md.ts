import type { APIRoute } from 'astro';
import { machineLocales } from '../../../lib/locales';
import { markdownResponse } from '../../../lib/markdown-endpoint';
import { pages, type Page } from '../../../lib/sections';

export async function getStaticPaths() {
  const all = await Promise.all(machineLocales.map(({ code }) => pages(code)));
  return all
    .flat()
    .filter((page) => page.slug !== 'index')
    .map((page) => ({ params: { locale: page.lang, section: page.section, slug: page.slug }, props: { page } }));
}

export const GET: APIRoute = ({ props }) => markdownResponse((props as { page: Page }).page);
