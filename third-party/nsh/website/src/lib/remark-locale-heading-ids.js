import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Slugger, { slug } from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';

// A translated page gives its headings the English page's ids, so a copied
// section link is short, readable and the same in every language
// (`/zh-CN/docs/fonts#fallbacks`, not `#%E5%9B%9E%E9%80%80…`). Headings pair up
// by position: a translation keeps the English outline (`tests/heading-ids.test.ts`
// checks the Chinese pages). Links to a section of a translated page, written
// with the translated heading (`./text.md#文字样式`, `#回退列表`), are rewritten
// to the English id too, so existing pages and machine translations keep working.

const SITE_ROOT = resolve(process.cwd());
const SECTIONS = new Set(['docs', 'elements', 'modules']);

/** `{ locale, section, name }` for a translated page, `undefined` for an English one. */
export function translatedPage(path) {
  const parts = relative(SITE_ROOT, resolve(path)).split(sep);
  if (parts[0] === 'zh-CN' && parts.length === 3 && SECTIONS.has(parts[1])) {
    return { locale: 'zh-CN', section: parts[1], name: parts[2] };
  }
  if (parts[0] === 'translations' && parts.length === 4 && SECTIONS.has(parts[2])) {
    return { locale: parts[1], section: parts[2], name: parts[3] };
  }
  return undefined;
}

function stripFrontmatter(source) {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

/**
 * The headings of a Markdown source, h1 title dropped as `remarkStripTitle`
 * does, with consecutive hyphens collapsed before duplicate ids are numbered.
 * `original` retains the GitHub-style id used by existing links.
 */
export function headingsOf(source) {
  const tree = fromMarkdown(stripFrontmatter(source));
  const first = tree.children.findIndex((n) => n.type !== 'html');
  if (first !== -1 && tree.children[first].type === 'heading' && tree.children[first].depth === 1) {
    tree.children.splice(first, 1);
  }
  const slugger = new Slugger();
  const original = new Slugger();
  const out = [];
  const walk = (node) => {
    if (node.type === 'heading') {
      const text = toString(node);
      // Normalize before deduplication: `A -- B` and `A - B` must stay unique.
      const id = slugger.slug(slug(text).replace(/-+/g, '-'));
      out.push({ depth: node.depth, slug: id, original: original.slug(text), node });
    } else for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

const cache = new Map();

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * For each page: its original heading ids in order and the English id at
 * each position. Pairing stops at the first heading whose level differs, so a
 * page whose outline drifted keeps its own ids past that point.
 */
export function idMap(path) {
  const key = resolve(path);
  if (cache.has(key)) return cache.get(key);
  let result;
  const page = translatedPage(key);
  const own = read(key);
  const english = page ? read(join(SITE_ROOT, page.section, page.name)) : own;
  if (own !== undefined && english !== undefined) {
    const mine = headingsOf(own);
    const theirs = own === english ? mine : headingsOf(english);
    const ids = [];
    for (let i = 0; i < mine.length; i++) {
      if (i < theirs.length && theirs[i].depth === mine[i].depth && ids.length === i) ids.push(theirs[i].slug);
      else break;
    }
    result = { own: mine.map((h) => h.original), english: theirs.map((h) => h.original), ids };
  }
  cache.set(key, result);
  return result;
}

/** The English id for `fragment` (a translated heading's slug) on the page at `path`. */
function translate(path, fragment) {
  const map = idMap(path);
  if (!map) return fragment;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {}
  const ownAt = map.own.indexOf(decoded);
  const at = ownAt !== -1 ? ownAt : map.english.indexOf(decoded);
  return at !== -1 && at < map.ids.length ? map.ids[at] : fragment;
}

export function remarkLocaleHeadingIds() {
  return (tree, file) => {
    const from = file?.path ?? file?.history?.[0];
    if (!from) return;
    const fromPath = resolve(from);
    const map = idMap(fromPath);
    const fallback = new Slugger();
    let index = 0;
    const walk = (node) => {
      if (node.type === 'heading') {
        // Same order as `headingsOf`: the leading h1 is already stripped.
        const id = map?.ids[index] ?? fallback.slug(slug(toString(node)).replace(/-+/g, '-'));
        node.data ??= {};
        node.data.hProperties = { ...node.data.hProperties, id };
        index++;
      }
      if ((node.type === 'link' || node.type === 'definition') && node.url) {
        const url = node.url;
        const hashAt = url.indexOf('#');
        if (hashAt !== -1 && !/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('/')) {
          const target = url.slice(0, hashAt);
          const fragment = url.slice(hashAt + 1);
          const targetPath = target ? resolve(dirname(fromPath), target.replace(/\?.*$/, '')) : fromPath;
          if (fragment) node.url = `${target}#${translate(targetPath, fragment)}`;
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
