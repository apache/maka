import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stripTabsMeta } from './remark-code-tabs.js';
import type { Page } from './sections';
import { BASE, REPO_URL, SITE_URL } from './site';

const ROOT = process.cwd();
const REPO_ROOT = resolve(ROOT, '..');

export function bodyWithoutFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/**
 * A page's Markdown for readers of the raw file (`<page>.md`, llms-full.txt):
 * one `# Title`, and links between pages turned into absolute `.md` URLs so a
 * client can follow them without the site's renderer.
 */
export function plainMarkdown(page: Page): string {
  const file = join(ROOT, page.filePath);
  let body = bodyWithoutFrontmatter(readFileSync(file, 'utf8'));
  body = body.replace(/^#\s+.+\r?\n+/, '');
  // Tabbed code blocks are plain consecutive blocks here.
  body = stripTabsMeta(body);
  // A diagram's light / dark pair (in its scroll wrapper) becomes one image
  // at an absolute URL.
  body = body.replace(
    /(?:<div class="diagram-scroll">\r?\n)?<img class="diagram diagram-light" src="\/([^"]+)" alt="([^"]*)">\r?\n<img class="diagram diagram-dark"[^>]*>(?:\r?\n<\/div>)?/g,
    (_, src: string, alt: string) => `![${alt}](${SITE_URL}${BASE}${src})`,
  );
  body = body.replace(/\]\(([^)\s]+?)\)/g, (whole, link: string) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('#') || link.startsWith('/') || link.startsWith('//')) return whole;
    const at = link.search(/[?#]/);
    const target = at === -1 ? link : link.slice(0, at);
    const hash = at === -1 ? '' : link.slice(at);
    if (!target.endsWith('.md')) return whole;
    const absolute = resolve(dirname(file), target);
    const rel = relative(ROOT, absolute);
    if (rel.startsWith('..')) {
      const inRepo = relative(REPO_ROOT, absolute);
      return inRepo.startsWith('..') ? whole : `](${REPO_URL}/blob/main/${inRepo.split(sep).join('/')}${hash})`;
    }
    const route = `/${rel.split(sep).join('/')}`.replace(/\.md$/, '').replace(/\/index$/, '');
    return `](${SITE_URL}${BASE.replace(/\/$/, '')}${route}.md${hash})`;
  });
  return `# ${page.title}\n\n${body}`;
}

export function markdownResponse(page: Page): Response {
  const front = [`url: ${SITE_URL}${page.href}`, `description: ${JSON.stringify(page.description)}`];
  if (page.demo) front.push(`demo: ${SITE_URL}${BASE}play/index.html#${page.demo}`);
  const text = `---\n${front.join('\n')}\n---\n\n${plainMarkdown(page)}\n`;
  return new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
