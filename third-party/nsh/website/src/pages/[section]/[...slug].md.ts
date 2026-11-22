import type { APIRoute } from 'astro';
import { markdownResponse } from '../../lib/markdown-endpoint';
import { pages, type Page } from '../../lib/sections';

// `/docs/signals.md` beside `/docs/signals`; a section's index is `/docs.md`.
export async function getStaticPaths() {
  return (await pages('en'))
    .filter((page) => page.slug !== 'index')
    .map((page) => ({ params: { section: page.section, slug: page.slug }, props: { page } }));
}

export const GET: APIRoute = ({ props }) => markdownResponse((props as { page: Page }).page);
