/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import {
  applyMermaidRenderBudget,
  MarkdownBody,
  MAX_AUTOMATIC_MERMAID_DIAGRAMS,
  MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH,
  MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH,
} from '../markdown-body.js';
import { AstryxLocaleProvider } from '../astryx-i18n.js';
import { MakaUriContext, Markdown } from '../markdown.js';
import { LocaleProvider } from '../locale-context.js';
import {
  createMermaidConfig,
  MAX_MERMAID_EDGES,
  MAX_MERMAID_SOURCE_LENGTH,
} from '../mermaid-diagram.js';

it('keeps raw HTML inert instead of expanding the Markdown trust surface', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '<details open><summary>Click</summary>payload</details>',
  }));

  assert.match(markup, /&lt;details open&gt;/);
  assert.doesNotMatch(markup, /<details/);
});

it('renders Markdown emphasis and LaTeX without exposing their source delimiters', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '**Calculating CRT Solution**\n\nSet \\( n \\equiv 3 \\pmod 7 \\) and \\( a = 5 \\).',
    density: 'compact',
  }));

  assert.match(markup, /<strong[^>]*>Calculating CRT Solution<\/strong>/);
  assert.match(markup, /class="maka-math maka-math-inline"/);
  assert.match(markup, /class="katex"/);
  assert.doesNotMatch(markup, /\*\*Calculating/);
  assert.doesNotMatch(markup, /\\\\\\\(/);
});

it('leaves LaTeX delimiters untouched inside inline and fenced code', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: ['Use `\\( x + 1 \\)` literally.', '', '```tex', '\\( y + 2 \\)', '```'].join('\n'),
  }));

  assert.doesNotMatch(markup, /class="maka-math/);
  assert.match(markup, /\\\( x \+ 1 \\\)/);
  assert.match(markup, /\\\( y \+ 2 \\\)/);
});

it('renders display math while leaving ordinary currency alone', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Budget: $5 and $10. Range: $5–$10.\n\n\\[ x^2 + y^2 = z^2 \\]',
  }));

  assert.match(markup, /Budget: \$5 and \$10\. Range: \$5–\$10/);
  assert.match(markup, /class="maka-math maka-math-display"/);
  assert.match(markup, /class="katex-display"/);
  assert.doesNotMatch(markup, /class="maka-math maka-math-inline"/);
});

it('does not treat shell variables, currency, or inline code as dollar-delimited math', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: [
      'Home: $HOME/$USER',
      'Path: $PATH:$HOME',
      'Prices: $5 and $10; range $5–$10; paired $5 and $10.',
      'Literal: `$x$`',
      'Explicit: \\( x + 1 \\)',
    ].join('\n\n'),
  }));

  assert.match(markup, /\$HOME\/\$USER/);
  assert.match(markup, /\$PATH:\$HOME/);
  assert.match(markup, /\$5 and \$10; range \$5–\$10; paired \$5 and \$10/);
  assert.match(markup, /<code[^>]*>\$x\$<\/code>/);
  assert.equal((markup.match(/class="maka-math maka-math-inline"/g) ?? []).length, 1);
  assert.match(markup, /class="katex"/);
});

it('keeps raw and malformed internal-token lookalikes literal', () => {
  for (const token of [
    '\uE000MAKAMATHIFFFFFFEND\uE001',
    '\uE000MAKAMATH:0:0:\uE001',
    '\uE000MAKAMATH:999:not-a-token:\uE001',
  ]) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, {
      text: `Before ${token} after with \\( x + 1 \\).`,
    }));

    assert.match(markup, new RegExp(token));
    assert.equal((markup.match(/class="maka-math maka-math-inline"/g) ?? []).length, 1);
  }
});

it('renders multiline display math outside code for both supported delimiters', () => {
  for (const [text, mathNode] of [
    [['Before', '', '$$', 'E = mc^2', '$$', '', 'After'].join('\n'), '<msup>'],
    [['Before', '', '\\[', 'x_1 + x_2 = y', '\\]', '', 'After'].join('\n'), '<msub>'],
  ]) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, { text }));

    assert.match(markup, /Before/);
    assert.match(markup, /After/);
    assert.match(markup, /class="maka-math maka-math-display"/);
    assert.match(markup, /class="katex-display"/);
    assert.doesNotMatch(markup, /\$\$/);
    assert.doesNotMatch(markup, /\\\[/);
    assert.match(markup, new RegExp(mathNode));
    assert.doesNotMatch(markup, /<em[^>]*>1<\/em>/);
  }
});

it('does not let multiline display math cross a fenced code block', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: ['$$', 'outside', '```tex', 'inside', '```', '$$'].join('\n'),
  }));

  assert.doesNotMatch(markup, /class="maka-math/);
  assert.match(markup, /\$\$/);
  assert.match(markup, /inside/);
});

it('keeps the copy control in a toolbar above a one-line code scroll viewport', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: ['```', `ssh-ed25519 ${'A'.repeat(200)}`, '```'].join('\n'),
    }),
  }));

  const toolbarIndex = markup.indexOf('astryx-codeblock-header');
  const copyButtonIndex = markup.indexOf('astryx-codeblock-copy-button');
  const scrollViewportIndex = markup.indexOf('role="group"');

  assert.match(markup, /data-maka-code-layout="single-line"/);
  assert.ok(toolbarIndex >= 0);
  assert.ok(copyButtonIndex > toolbarIndex);
  assert.ok(scrollViewportIndex > copyButtonIndex);
});

it('does not force the single-line scrollbar layout on multiline code', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: ['```ts', 'const first = 1;', 'const second = 2;', '```'].join('\n'),
    }),
  }));

  assert.match(markup, /data-maka-code-layout="multi-line"/);
  assert.match(markup, /astryx-codeblock-header/);
  assert.match(markup, /astryx-codeblock-copy-button/);
});

it('gives collapsible plaintext code a localized accessible name', () => {
  const code = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

  for (const [locale, label] of [['en', 'Code'], ['zh', '代码']] as const) {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale,
      children: createElement(AstryxLocaleProvider, {
        children: createElement(MarkdownBody, {
          text: ['```', ...code, '```'].join('\n'),
        }),
      }),
    }));

    assert.match(markup, /role="button"/);
    assert.match(markup, /aria-expanded="true"/);
    assert.match(markup, new RegExp(`>${label}</span>`));
  }
});

it('keeps standalone MarkdownBody compatible for collapsible plaintext code', () => {
  const code = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: ['```', ...code, '```'].join('\n'),
  }));

  assert.match(markup, /role="button"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, />Code<\/span>/);
});

it('keeps a lazy live stream behind the display cursor', () => {
  const markup = renderToStaticMarkup(createElement(Markdown, {
    text: 'live output that has not reached the display cursor',
    streaming: true,
  }));

  assert.doesNotMatch(markup, /live output/);
});

it('redacts secrets before even the lazy Markdown fallback reaches the rendered tree', () => {
  const markup = renderToStaticMarkup(createElement(Markdown, {
    text: 'Authorization: Bearer sk-live-1234567890abcdef',
  }));

  assert.doesNotMatch(markup, /sk-live-1234567890abcdef/);
  assert.match(markup, /&lt;redacted&gt;/);
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

  assert.match(markup, /<button\b/);
  assert.match(markup, /data-maka-uri-kind="settings"/);
  assert.doesNotMatch(markup, /Blocked URL/);
});

it('keeps non-allowlisted external schemes inert', () => {
  for (const href of [
    'file:///Users/example/.ssh/id_rsa',
    'custom://private-resource',
    'javascript:alert(1)',
    'data:text/html,private',
  ]) {
    const markup = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        {
          locale: 'en',
          children: createElement(MarkdownBody, {
            text: `[unsafe](${href})`,
          }),
        },
      ),
    );

    assert.doesNotMatch(markup, /<a\b/, href);
    if (href.startsWith('file:') || href.startsWith('custom:')) {
      assert.match(markup, /data-reason="unsafe-scheme"/, href);
      // The affordance is the `title` tooltip, not an aria-label: the span is
      // role-less, so a name on it was never announced. Asserting on title
      // keeps the guarantee that the reason reaches the user at all.
      assert.match(markup, /title="Unsafe link"/, href);
      assert.doesNotMatch(markup, /aria-label="Unsafe link"/, href);
    }
  }
});

it('never loads non-allowlisted Markdown image sources', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: [
      '![standalone](file:///Users/example/.ssh/id_rsa)',
      '',
      'caption ![inline](custom://private-resource)',
      '',
      '![data](data:image/png;base64,aW1n)',
      '',
      '![reference][avatar]',
      '',
      '[avatar]: file:///Users/example/private.png',
    ].join('\n'),
  }));

  assert.doesNotMatch(markup, /<img\b/);
  assert.doesNotMatch(markup, /\bsrc="(?:file|custom):/);
});

it('does not treat navigation and communication schemes as image resources', () => {
  for (const src of [
    'maka://tool/run',
    'MAKA://auth/login',
    'maka://settings/models',
    'maka://compose?text=hello',
    'maka://runtime/attachments/attachment-123?session=other',
    'maka://runtime/attachments/not-an-artifact',
    'mailto:user@example.com',
  ]) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, {
      text: `![not-an-image](${src})`,
    }));

    assert.doesNotMatch(markup, /<img\b/, src);
    assert.doesNotMatch(markup, /\bsrc=/, src);
  }
});

it('shows an attachment placeholder when no session reader is installed', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '![preview](maka://runtime/attachments/attachment-123)',
  }));

  assert.match(markup, />\[preview\]</);
  assert.doesNotMatch(markup, /maka:\/\/runtime\/attachments/);
  assert.doesNotMatch(markup, /<img\b/);
});

it('defers Mermaid fences beyond the per-Markdown automatic diagram budget', () => {
  const fence = (index: number) => [
    '```mermaid',
    `flowchart LR\nA${index} --> B${index}`,
    '```',
  ].join('\n');
  const markup = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(MarkdownBody, {
          text: Array.from(
            { length: MAX_AUTOMATIC_MERMAID_DIAGRAMS + 1 },
            (_, index) => fence(index),
          ).join('\n\n'),
        }),
      },
    ),
  );

  assert.equal(markup.match(/data-maka-mermaid-state="loading"/g)?.length, 3);
  assert.equal(markup.match(/data-maka-mermaid-state="deferred"/g)?.length, 1);
  assert.match(markup, /Render diagram/);
  assert.doesNotMatch(markup, /makamermaiddeferred/);
});

it('enforces per-diagram and total automatic Mermaid source budgets', () => {
  const oversized = ['```mermaid', 'x'.repeat(MAX_AUTOMATIC_MERMAID_SOURCE_LENGTH + 1), '```'].join('\n');
  assert.match(
    applyMermaidRenderBudget(oversized),
    /```makamermaiddeferred/,
  );

  const nearHalfTotal = 'x'.repeat(Math.floor(MAX_AUTOMATIC_MERMAID_TOTAL_SOURCE_LENGTH / 2) - 100);
  const source = [nearHalfTotal, nearHalfTotal, 'x'.repeat(250)]
    .map((code) => ['```mermaid', code, '```'].join('\n'))
    .join('\n\n');
  assert.equal(
    applyMermaidRenderBudget(source).match(/```makamermaiddeferred/g)?.length,
    1,
  );
});

it('does not render Mermaid while the assistant turn is streaming', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: ['```mermaid', 'flowchart LR', 'A --> B', '```'].join('\n'),
    streaming: true,
  }));

  assert.doesNotMatch(markup, /data-maka-contract="mermaid"/);
});

it('pins Mermaid security and complexity limits for untrusted assistant output', () => {
  const config = createMermaidConfig('dark');

  assert.equal(config.startOnLoad, false);
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.suppressErrorRendering, true);
  assert.equal(config.htmlLabels, false);
  assert.equal(config.maxTextSize, MAX_MERMAID_SOURCE_LENGTH);
  assert.equal(config.maxEdges, MAX_MERMAID_EDGES);
  assert.equal(config.theme, 'dark');
});

it('keeps a new stream behind the display cursor on its first render', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'new output that has not been presented yet',
    streaming: true,
  }));

  assert.doesNotMatch(markup, /new output that has not been presented yet/);
});

it('shows only the restored prefix on its first streaming render', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '**output restored** with a new delta',
    streaming: true,
    settledText: '**output restored**',
  }));

  assert.match(markup, /<strong[^>]*>output restored<\/strong>/);
  assert.doesNotMatch(markup, /new delta/);
});

it('uses the same protected math registry for live and settled streaming text', () => {
  const rawToken = '\uE000MAKAMATH:0:0:\uE001';
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: `Stable ${rawToken} \\( x + 1 \\) with a new delta`,
    streaming: true,
    settledText: `Stable ${rawToken} \\( x + 1 \\)`,
  }));

  assert.match(markup, new RegExp(rawToken));
  assert.match(markup, /class="maka-math maka-math-inline"/);
  assert.match(markup, /class="katex"/);
  assert.doesNotMatch(markup, /new delta/);
});

it('settles only the verified prefix when restored content was rewritten', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'prefix <redacted> NEW',
    streaming: true,
    settledText: 'prefix sk-123456789012345',
  }));

  assert.match(markup, />prefix </);
  assert.doesNotMatch(markup, /redacted|NEW/);
});

it('never settles half of a rewritten Unicode code point', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'same 😃 NEW',
    streaming: true,
    settledText: 'same 😀 old',
  }));

  assert.match(markup, />same </);
  assert.doesNotMatch(markup, /😃|NEW|�/u);
});
