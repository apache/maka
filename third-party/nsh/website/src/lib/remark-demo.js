import { demoPanelHtml } from './demo.js';

// A page whose frontmatter names a demo (`demo: counter`) shows it after its
// first paragraph: the reader gets the one-line introduction, then the thing
// running. A section of the page with a demo of its own names it in a comment
// on a line of its own (`<!-- demo: el-plot-pie -->`), shown where the comment
// is. `state` is unused here; it is in the options only so the content cache
// is invalidated when the demos or the player change (see demo.js).
const SECTION_DEMO = /^<!--\s*demo:\s*([\w-]+)\s*-->$/;

export function remarkDemo({ base = '/' } = {}) {
  return async (tree, file) => {
    const path = file?.path ?? file?.history?.[0] ?? '';
    const lang = /[\\/]zh-CN[\\/]/.test(path) ? 'zh-CN' : 'en';
    for (const node of tree.children) {
      const section = node.type === 'html' && SECTION_DEMO.exec(node.value.trim());
      if (section) node.value = await demoPanelHtml(section[1], { base, lang });
    }

    const name = file?.data?.astro?.frontmatter?.demo;
    if (!name) return;
    const html = await demoPanelHtml(name, { base, lang });

    const at = tree.children.findIndex((node) => node.type === 'paragraph');
    tree.children.splice(at === -1 ? 0 : at + 1, 0, { type: 'html', value: html });
  };
}
