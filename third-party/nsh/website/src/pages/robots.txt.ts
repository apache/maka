import type { APIRoute } from 'astro';
import { BASE, SITE_URL } from '../lib/site';

export const GET: APIRoute = () =>
  new Response(['User-agent: *', 'Allow: /', '', `Sitemap: ${SITE_URL}${BASE}sitemap.xml`, ''].join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
