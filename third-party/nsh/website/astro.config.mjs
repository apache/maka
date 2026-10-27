import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import pagefind from 'astro-pagefind';
import { rehypeHeadingIds, unified } from '@astrojs/markdown-remark';
import { remarkCallouts } from './src/lib/remark-callouts.js';
import { remarkCodeTabs } from './src/lib/remark-code-tabs.js';
import { remarkDemo } from './src/lib/remark-demo.js';
import { remarkDocLinks } from './src/lib/remark-doc-links.js';
import { remarkStripTitle } from './src/lib/remark-strip-title.js';
import { rehypeHeadingAnchors } from './src/lib/rehype-heading-anchors.js';
import { demoState } from './src/lib/demo.js';
import { shikiConfig } from './src/lib/markdown.js';
import { playDev } from './src/lib/play-dev.js';
import { galleryUiStyles } from './src/lib/gallery-ui-css.js';

const configuredBase = process.env.PUBLIC_SITE_BASE || '/';
const BASE = configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;

export default defineConfig({
  site: 'https://nsh.dev',
  base: BASE,
  output: 'static',
  trailingSlash: 'never',

  // The platform pages' former paths.
  redirects: {
    '/docs/embedding-ios': '/docs/ios',
    '/docs/embedding-android': '/docs/android',
    '/zh-CN/docs/embedding-ios': '/zh-CN/docs/ios',
    '/zh-CN/docs/embedding-android': '/zh-CN/docs/android',
  },

  integrations: [pagefind()],

  markdown: {
    processor: unified({
      remarkPlugins: [
        remarkStripTitle,
        remarkCallouts,
        remarkCodeTabs,
        [remarkDocLinks, { base: BASE }],
        [remarkDemo, { base: BASE, state: demoState() }],
      ],
      rehypePlugins: [rehypeHeadingIds, rehypeHeadingAnchors],
    }),
    shikiConfig,
    defaultHighlightLang: 'sh',
  },

  vite: {
    plugins: [galleryUiStyles(), tailwindcss(), playDev(BASE)],
    // The playground's editor (CodeMirror, about 500 kB) is one chunk,
    // loaded by that page only.
    build: { chunkSizeWarningLimit: 600 },
  },
});
