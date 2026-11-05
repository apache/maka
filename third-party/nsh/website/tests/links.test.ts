import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Every internal link of a finished build (`bun run build` first) must reach
// a file of the same build. Anchors are checked against the target page's ids.

const dist = join(import.meta.dir, '..', process.env.SITE_TEST_DIST ?? 'dist');
const base = `/${(process.env.PUBLIC_SITE_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');

function htmlFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === 'pagefind' || name === '_astro') return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? htmlFiles(path) : path.endsWith('.html') ? [path] : [];
  });
}

const decode = (value: string) => value.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&quot;/g, '"');

/** The built file a site path is served from, if any. */
function resolveFile(path: string): string | undefined {
  const clean = decodeURIComponent(path).replace(/\/+$/, '');
  const file = join(dist, clean);
  return [file, `${file}.html`, join(file, 'index.html')].find((c) => existsSync(c) && statSync(c).isFile());
}

const built = existsSync(dist);
const pages = built ? htmlFiles(dist) : [];
const ids = new Map<string, Set<string>>();
const idsOf = (file: string) => {
  let set = ids.get(file);
  if (!set) {
    set = new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1])));
    ids.set(file, set);
  }
  return set;
};

test('the site is built', () => {
  expect(built).toBe(true);
  expect(pages.length).toBeGreaterThan(3);
  for (const file of ['index.html', 'zh-CN/index.html', '404.html', 'llms.txt', 'llms-full.txt', 'sitemap.xml', 'robots.txt']) {
    expect(existsSync(join(dist, file))).toBe(true);
  }
});

test('internal links reach a built page and anchor', () => {
  const broken: string[] = [];
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const from = page.slice(dist.length);
    for (const [tag, raw] of html.matchAll(/<a\s[^>]*?href="([^"]*)"[^>]*>/g)) {
      // The version menu's links may name a page another version lacks:
      // the menu falls back to that version's home (`Nav.astro`).
      if (tag.includes('data-version-link')) continue;
      const href = decode(raw);
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) continue;
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        if (id && !idsOf(page).has(id)) broken.push(`${from} → ${href}`);
        continue;
      }
      if (!href.startsWith('/')) {
        broken.push(`${from} → ${href} (relative)`);
        continue;
      }
      if (!href.startsWith(base) && `${href}/` !== base) {
        broken.push(`${from} → ${href} (outside ${base})`);
        continue;
      }
      const [pathAndQuery, hash] = href.split('#');
      const path = pathAndQuery.split('?')[0].slice(base.length - 1);
      const file = resolveFile(path || '/');
      if (!file) {
        broken.push(`${from} → ${href}`);
        continue;
      }
      // The player's hash names a demo, the playground's holds its state
      // (`#demo=`, `#code=`): no element.
      if (hash && !path.startsWith('/play/') && !hash.includes('=') && file.endsWith('.html') && !idsOf(file).has(decodeURIComponent(hash))) broken.push(`${from} → ${href} (no #${hash})`);
    }
  }
  expect(broken).toEqual([]);
});

test('images in pages reach a built file below the base', () => {
  const broken: string[] = [];
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const [, raw] of html.matchAll(/<img\s[^>]*?src="([^"]*)"/g)) {
      const src = decode(raw);
      if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) continue;
      const path = src.split(/[?#]/)[0];
      if (!path.startsWith(base) || !resolveFile(path.slice(base.length - 1))) broken.push(`${page.slice(dist.length)} → ${src}`);
    }
  }
  expect(broken).toEqual([]);
});

test('every content page has its Markdown twin', () => {
  const missing = pages
    // A former path's redirect (`redirects` in astro.config.mjs) has no content of its own.
    .filter((page) => !readFileSync(page, 'utf8').includes('http-equiv="refresh"'))
    .map((page) => page.slice(dist.length).replace(/\/index\.html$/, ''))
    .filter((route) => /^\/(?:zh-CN\/)?(?:docs|elements|components|modules)(?:\/|$)/.test(route))
    .filter((route) => !existsSync(join(dist, `${route}.md`)));
  expect(missing).toEqual([]);
});
