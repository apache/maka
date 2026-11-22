import type { APIRoute } from 'astro';
import { markdownResponse } from '../lib/markdown-endpoint';
import { pages, type Page } from '../lib/sections';

export async function getStaticPaths() {
  return (await pages('en'))
    .filter((page) => page.slug === 'index')
    .map((page) => ({ params: { section: page.section }, props: { page } }));
}

export const GET: APIRoute = ({ props }) => markdownResponse((props as { page: Page }).page);
