import { dirname, relative, resolve, sep } from 'node:path';

// Pages link to each other as files, the way they read on GitHub:
// `[List](../elements/list.md)`, `[signals](./reactivity.md#signals)`. The
// content directories mirror the routes — `elements/list.md` is
// `/elements/list`, `zh-CN/docs/x.md` is `/zh-CN/docs/x` — so a link resolves to
// the file it names relative to the page, and the route is that file's path
// without `.md` (`index` dropped). A Chinese page linking `../elements/list.md`
// therefore stays in Chinese. A link that leaves `website/` points at the file
// on GitHub instead (`../../docs/dev/architecture.md`). Root paths, in links
// (`[Playground](/playground)`) and raw HTML (`<img src="/diagrams/…">`), get
// the site's base.

const SITE_ROOT = resolve(process.cwd());
const REPO_ROOT = resolve(SITE_ROOT, '..');
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|gz|txt|json)$/i;

function isExternal(url) {
  return /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//');
}

export function remarkDocLinks({ base = '/', repo = 'https://github.com/longbridge/nsh' } = {}) {
  const prefix = base.replace(/\/+$/, '');

  return (tree, file) => {
    const from = file?.path ?? file?.history?.[0];
    if (!from) return;
    const fromDir = dirname(resolve(from));

    const rewrite = (node) => {
      const url = node.url;
      if (!url || isExternal(url) || url.startsWith('#')) return;
      // Site routes that are no Markdown file (`/playground`, `/llms.txt`):
      // below the base, like the rest.
      if (url.startsWith('/')) {
        if (prefix && !url.startsWith(`${prefix}/`)) node.url = `${prefix}${url}`;
        return;
      }

      const hashAt = url.search(/[?#]/);
      const target = hashAt === -1 ? url : url.slice(0, hashAt);
      const hash = hashAt === -1 ? '' : url.slice(hashAt);
      if (!target || ASSET.test(target)) return;

      const absolute = resolve(fromDir, target);
      const rel = relative(SITE_ROOT, absolute);
      if (rel.startsWith('..')) {
        const inRepo = relative(REPO_ROOT, absolute);
        if (!inRepo.startsWith('..')) node.url = `${repo}/blob/main/${inRepo.split(sep).join('/')}${hash}`;
        return;
      }

      // Machine translations sit in `translations/<locale>/…` but route at `/<locale>/…`.
      const withoutExt = rel.replace(/\.md$/, '').replace(/^translations[/\\]/, '');
      const route = `/${withoutExt.split(sep).join('/')}`.replace(/\/index$/, '');
      node.url = `${prefix}${route || '/'}${hash}`;
    };

    // Raw HTML (the light / dark diagram pairs) names site files from the
    // root, `src="/diagrams/x.svg"`; put them below the base.
    const rewriteHtml = (node) => {
      if (prefix) node.value = node.value.replace(/\b(src|href)="\/(?!\/)/g, `$1="${prefix}/`);
    };

    const walk = (node) => {
      if (node.type === 'link' || node.type === 'definition') rewrite(node);
      if (node.type === 'html') rewriteHtml(node);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
