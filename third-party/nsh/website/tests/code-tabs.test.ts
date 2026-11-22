import { expect, test } from 'bun:test';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { remarkCodeTabs, stripTabsMeta, tabLabel } from '../src/lib/remark-code-tabs.js';

// Consecutive fences marked `tabs` become one tab group; the raw Markdown the
// `.md` endpoints and llms-full.txt print keeps them as plain blocks.

const SOURCE = [
  'Intro.',
  '',
  '```rust tabs',
  'view()',
  '```',
  '',
  '```tsx tabs',
  '<View />',
  '```',
  '',
  'Between.',
  '',
  '```tsx',
  'plain()',
  '```',
  '',
  '```sh tabs title="x"',
  'nsh run',
  '```',
  '',
].join('\n');

async function render(markdown: string, path = 'elements/view.md') {
  const file = await unified()
    .use(remarkParse)
    .use(remarkCodeTabs)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process({ value: markdown, path });
  return String(file);
}

test('consecutive tabbed fences become one accessible group', async () => {
  const html = await render(SOURCE);
  expect(html.match(/data-code-tabs/g)?.length).toBe(2);
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-label="Language"');
  // Rust first and selected, TSX second and hidden.
  expect(html).toMatch(/<button[^>]*aria-selected="true"[^>]*data-tab="rust"[^>]*>Rust<\/button><button[^>]*aria-selected="false"[^>]*data-tab="tsx"[^>]*>TSX<\/button>/);
  expect(html).toMatch(/role="tabpanel"[^>]*data-tab="tsx"[^>]*hidden/);
  expect(html).toMatch(/role="tabpanel"[^>]*data-tab="rust"(?![^>]*hidden)/);
  // Each tab names its panel and each panel its tab.
  expect(html).toContain('aria-controls="code-tabs-1-panel-0"');
  expect(html).toContain('aria-labelledby="code-tabs-1-tab-0"');
  // An unmarked fence stays a plain block; a lone marked fence is a group of one.
  expect(html).toContain('<pre><code class="language-tsx">plain()');
  expect(html).toMatch(/data-tab="sh"[^>]*>Shell<\/button>/);
});

test('Chinese pages label the tab list in Chinese', async () => {
  expect(await render(SOURCE, 'zh-CN/elements/view.md')).toContain('aria-label="语言"');
});

test('labels name the language', () => {
  expect(tabLabel('rust')).toBe('Rust');
  expect(tabLabel('tsx')).toBe('TSX');
  expect(tabLabel('swift')).toBe('Swift');
  expect(tabLabel(undefined)).toBe('Text');
});

test('the raw Markdown keeps every block, without the tabs word', () => {
  const plain = stripTabsMeta(SOURCE);
  expect(plain).toContain('```rust\nview()');
  expect(plain).toContain('```tsx\n<View />');
  expect(plain).toContain('```sh title="x"\nnsh run');
  expect(plain).not.toMatch(/\btabs\b/);
});
