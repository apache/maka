import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import { MarkdownBody } from '../markdown-body.js';
import { MakaUriContext } from '../markdown.js';
import { LocaleProvider } from '../locale-context.js';

it('keeps raw HTML inert instead of expanding the Markdown trust surface', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '<details open><summary>Click</summary>payload</details>',
  }));

  assert.match(markup, /&lt;details open&gt;/);
  assert.doesNotMatch(markup, /<details/);
});

it('exposes one stable Maka root around rendered Markdown blocks', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '# Heading\n\nparagraph',
  }));

  assert.match(markup, /^<div class="[^"]*\bmaka-markdown-root\b[^"]*">/);
});

it('preserves allowlisted Maka navigation links through sanitization', () => {
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(
          MakaUriContext.Provider,
          { value: () => {} },
          createElement(MarkdownBody, {
            text: '[Models](maka://settings/models)',
          }),
        ),
      },
    ),
  );

  assert.match(markup, /<button[^>]*class="maka-markdown-link maka-markdown-link-internal"/);
  assert.match(markup, /data-maka-uri-kind="settings"/);
  assert.doesNotMatch(markup, /Blocked URL/);
});

it('preserves GFM task-list HAST classes so prose.css task-list rules match (#739 round-2 guard)', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '- [x] done\n- [ ] todo',
  }));
  // bareElement must preserve the HAST className react-markdown forwards
  // (remark-gfm's contains-task-list / task-list-item). Dropping it — the
  // round-2 regression — makes prose.css's `.maka-prose ul.contains-task-list`
  // rules stop matching, so task-list checkboxes fall back to the UA default
  // and list markers reappear. This render assertion locks the HAST-className
  // contract that the text-shape contract alone cannot catch.
  assert.match(markup, /class="contains-task-list"/, 'bareElement must preserve the HAST className remark-gfm sets on the task-list <ul>; dropping it (round-2 regression) makes prose.css .maka-prose ul.contains-task-list rules stop matching');
  assert.match(markup, /class="task-list-item"/, 'bareElement must preserve the HAST className remark-gfm sets on task-list <li> items');
});

it('renders a hard break as a native <br> plus the spacing span (MARKDOWN-PROSE-CJK-MIXED-SPACING-0)', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '**小节标题**\n正文内容',
  }));

  // The source is a SINGLE newline on purpose: `remarkBreaks` is what makes it
  // a break at all, and without the plugin .maka-hardbreak becomes unreachable
  // dead CSS — a regression no CSS contract can see.
  assert.match(
    markup,
    /<br\s*\/?>\s*<span class="maka-hardbreak" aria-hidden="true">/,
    'a hard break must render as a native <br> followed by the .maka-hardbreak span — the <br> carries the line-break semantics (AX LineBreak node) and the span carries the 6px gap that CSS cannot put on a <br>',
  );
});
