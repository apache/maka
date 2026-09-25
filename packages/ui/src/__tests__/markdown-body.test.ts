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
import { performance } from 'node:perf_hooks';
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
import { createMarkdownMathCache, prepareMarkdownMath } from '../markdown-math.js';
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

it('keeps URL, email, and Markdown markers atomic inside math', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: [
        'URL \\( \\texttt{https://example.com} \\)',
        'Email \\( \\text{person@example.com} \\)',
        'Markers \\( x \\left[y\\right] * z \\)',
      ].join('\n\n'),
      streaming: true,
      settledText: [
        'URL \\( \\texttt{https://example.com} \\)',
        'Email \\( \\text{person@example.com} \\)',
        'Markers \\( x \\left[y\\right] * z \\)',
      ].join('\n\n'),
    }),
  }));

  assert.equal((markup.match(/class="maka-math maka-math-inline"/g) ?? []).length, 3);
  assert.equal((markup.match(/class="katex"/g) ?? []).length, 3);
  assert.doesNotMatch(markup, /<a\b|mailto:/);
  assert.doesNotMatch(markup, /\\\(|\\\)/);
});

it('falls back to ordinary Markdown for an empty formula', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Empty \\( \\) end',
  }));

  assert.doesNotMatch(markup, /class="maka-math/);
  assert.doesNotMatch(markup, /\\\(|\\\)/);
  assert.match(markup, /Empty \( \) end/);
});

it('keeps literal math transport syntax as prose', () => {
  const literalToken = '\uE000MAKA_MATH:0:78\uE001';
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: `Literal ${literalToken} end`,
  }));

  assert.doesNotMatch(markup, /class="maka-math/);
  assert.match(markup, new RegExp(literalToken));
});

it('leaves LaTeX delimiters untouched inside inline and fenced code', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: ['Use `\\( x + 1 \\)` literally.', '', '```tex', '\\( y + 2 \\)', '```'].join('\n'),
  }));

  assert.doesNotMatch(markup, /class="maka-math/);
  assert.match(markup, /\\\( x \+ 1 \\\)/);
  assert.match(markup, /\\\( y \+ 2 \\\)/);
});

it('does not let an unmatched inline backtick hide later math', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Unmatched ` prose.\n\nMath \\(x + 1\\)',
  }));

  assert.match(markup, /class="maka-math maka-math-inline"/);
  assert.match(markup, /class="katex"/);
});

it('does not let an unmatched math delimiter hide a later formula', () => {
  for (const text of [
    'bad \\( then \\[x\\]',
    'bad $$ then \\(x\\)',
    'bad \\[ then \\(x\\)',
  ]) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, { text }));
    assert.match(markup, /class="maka-math/);
    assert.match(markup, /class="katex/);
  }
});

it('lets a formula own backticks that occur inside its delimiters', () => {
  for (const formula of ['\\(x ` y\\)', '\\(x \\text{`foo`}\\)']) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, { text: formula }));
    assert.match(markup, /class="maka-math maka-math-inline"/);
    assert.match(markup, /class="katex"/);
  }
});

it('keeps scanning after a malformed math transport prefix', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: `bad \uE000MAKA_MATH:bad then \\(x\\)`,
  }));

  assert.match(markup, /MAKA_MATH:bad/);
  assert.match(markup, /class="maka-math maka-math-inline"/);
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

it('renders display math inside blockquotes and list items', () => {
  for (const text of ['> \\[ x + 1 \\]', '- \\[ x + 1 \\]']) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, { text }));
    assert.match(markup, /class="maka-math maka-math-display"/);
    assert.match(markup, /class="katex-display"/);
    assert.doesNotMatch(markup, /\\\[/);
  }
});

it('promotes a mid-paragraph $$…$$ span to display math', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Before $$x + 1$$ after',
  }));

  assert.match(markup, /Before/);
  assert.match(markup, /after/);
  assert.match(markup, /class="maka-math maka-math-display"/);
  assert.doesNotMatch(markup, /\$\$/);
});

it('keeps `$` inside link destinations literal while prose stays dollar-escaped', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '[priced](https://example.com/?$from$=$to$) and $z$ here',
    }),
  }));

  assert.match(markup, /href="https:\/\/example\.com\/\?\$from\$=\$to\$"/);
  assert.match(markup, /and \$z\$ here/);
  assert.doesNotMatch(markup, /class="maka-math/);
});

it('renders inline math glued to digits and formulas holding escaped dollars', () => {
  for (const text of ['v2\\(x + 1\\)3 done', 'cost \\(a \\$ b\\) end']) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, { text }));
    assert.match(markup, /class="maka-math maka-math-inline"/);
    assert.doesNotMatch(markup, /\\\(|\\\)/);
  }
});

it('leaves no zero-width separators around inline math with benign neighbors', () => {
  for (const text of [
    'the value \\(x\\) is fine',
    'ends with \\(x\\)',
  ]) {
    const markup = renderToStaticMarkup(createElement(MarkdownBody, { text }));
    assert.match(markup, /class="maka-math maka-math-inline"/);
    assert.doesNotMatch(markup, /\u200B/, text);
  }
});

it('keeps adjacent inline formulas parseable through a separator', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'compare \\(x\\)\\(y\\) here',
  }));
  assert.equal(
    (markup.match(/class="maka-math maka-math-inline"/g) ?? []).length,
    2,
  );
});

it('keeps display math inside a table cell without splitting the row', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: '| a | b |\n| --- | --- |\n| \\(x + 1\\) | \\[y + 2\\] |',
  }));

  assert.match(markup, /<table/);
  assert.equal((markup.match(/class="maka-math maka-math-inline"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /\\\(|\\\]|\\\[/);
});

it('keeps display math intact across Markdown-looking block boundaries', () => {
  const bodies = [
    ['x + 1', '', 'y + 2'],
    ['x + 1', '# heading-shaped'],
    ['x + 1', '- list-shaped'],
    ['x + 1', '| table | shaped |', '| --- | --- |'],
  ];

  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]']]) {
    for (const body of bodies) {
      const markup = renderToStaticMarkup(createElement(MarkdownBody, {
        text: ['Before', '', open, ...body, close, '', 'After'].join('\n'),
      }));

      assert.match(markup, /class="maka-math maka-math-display"/);
      assert.doesNotMatch(markup, /<h1\b|<ul\b|<table\b/);
    }
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

it('keeps escaped brackets in link labels out of display math', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh-CN',
    children: createElement(MarkdownBody, {
      text: '[\\[DISCUSS\\] Clarify Maka sandbox contracts and runtime dependency access](https://github.com/apache/maka/discussions/5304)',
    }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/github\.com\/apache\/maka\/discussions\/5304"/);
  assert.doesNotMatch(markup, /maka-math-display/);
  assert.doesNotMatch(markup, /katex-display/);
  assert.match(markup, /\[DISCUSS\] Clarify Maka sandbox contracts and runtime dependency access/);
});

it('still renders inline math inside link labels', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '[see \\(x+1\\) here](https://example.com)',
    }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com"/);
  assert.match(markup, /class="maka-math maka-math-inline"/);
  assert.doesNotMatch(markup, /maka-math-display/);
});

it('keeps dollar display math in link labels as literal text', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '[a $$x^2$$ b](https://example.com)',
    }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com"/);
  assert.doesNotMatch(markup, /maka-math-display/);
  assert.match(markup, /\$\$x\^2\$\$/);
});

it('still renders display math outside link labels', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '[plain](https://example.com)\n\n\\[ y^2 \\]',
    }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com"/);
  assert.match(markup, /class="maka-math maka-math-display"/);
  assert.match(markup, /class="katex-display"/);
});

it('preserves escaped brackets across reference link forms', () => {
  const cases = [
    {
      use: '[\\[DISCUSS\\] Clarify][topic]',
      definition: '[topic]: https://example.com/topic',
    },
    {
      use: '[\\[DISCUSS\\] Clarify][]',
      definition: '[\\[DISCUSS\\] Clarify]: https://example.com/collapsed',
    },
    {
      use: '[\\[DISCUSS\\] Clarify]',
      definition: '[\\[DISCUSS\\] Clarify]: https://example.com/shortcut',
    },
  ];

  for (const { use, definition } of cases) {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(MarkdownBody, {
        text: `${use}\n\n${definition}`,
      }),
    }));

    assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com\//);
    assert.match(markup, /\[DISCUSS\] Clarify/);
    assert.doesNotMatch(markup, /maka-math-display|katex-display/);
  }
});

it('matches escaped reference identifiers between use and definition', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '[visible][\\[topic\\]]\n\n[\\[topic\\]]: https://example.com/ref',
    }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com\/ref"/);
  assert.match(markup, />visible</);
  assert.doesNotMatch(markup, /maka-math-display|katex-display/);
});

it('keeps link targets identical between one-shot and incremental scans', () => {
  const full = '[label](https://example.com/$$value$$)';
  const cache = createMarkdownMathCache();
  let incremental = '';
  for (let end = 1; end <= full.length; end++) {
    incremental = prepareMarkdownMath(full.slice(0, end), cache);
  }

  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));
  assert.doesNotMatch(incremental, /MAKA_MATH/);

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: full }),
  }));

  assert.match(markup, /href="https:\/\/example\.com\/\$\$value\$\$"/);
});

it('preserves escape parity when an incremental scan resumes inside a backslash run', () => {
  const cases = [
    '\\\\[\\] x]',
    '\\\\\\\\[\\] x]',
    '\\\\[```\\[(\\]',
  ];

  for (const full of cases) {
    const cache = createMarkdownMathCache();
    let incremental = '';
    for (let end = 1; end <= full.length; end++) {
      incremental = prepareMarkdownMath(full.slice(0, end), cache);
    }

    assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()), full);
  }
});

it('matches escaped image reference identifiers between use and definition', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '![visible][\\[topic\\]]\n\n[\\[topic\\]]: https://example.com/image.png',
    }),
  }));

  assert.match(markup, /<img\b[^>]*src="https:\/\/example\.com\/image\.png"/);
  assert.match(markup, /alt="visible"/);
  assert.doesNotMatch(markup, /maka-math-display|katex-display/);
});

it('keeps image alt escapes out of math without leaking transport tokens', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, {
      text: '![\\[alt\\] preview](https://example.com/x.png)',
    }),
  }));

  assert.doesNotMatch(markup, /maka-math/);
  assert.doesNotMatch(markup, /MAKA_MATH/);
});

it('keeps a split image opener identical between incremental and one-shot scans', () => {
  const full = '!![alt \\[x\\]](https://example.com/a.png)';
  const cache = createMarkdownMathCache();
  let incremental = '';
  for (let end = 1; end <= full.length; end++) {
    incremental = prepareMarkdownMath(full.slice(0, end), cache);
  }

  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: full }),
  }));

  assert.match(markup, /<img\b[^>]*src="https:\/\/example\.com\/a\.png"/);
  assert.match(markup, /alt="alt \[x\]"/);
  assert.doesNotMatch(markup, /maka-math/);
  assert.doesNotMatch(markup, /MAKA_MATH/);
});

it('settles bounded labels ending in $ instead of rescanning the stream', () => {
  const head = '[price$](https://example.com)';
  const filler = `\n\n${'lorem ipsum dolor sit amet. '.repeat(16_384)}`;
  const full = head + filler;
  const cache = createMarkdownMathCache();
  const updates = 64;
  const started = performance.now();
  let incremental = '';
  for (let step = 1; step <= updates; step++) {
    incremental = prepareMarkdownMath(full.slice(0, Math.ceil((full.length * step) / updates)), cache);
  }
  const elapsed = performance.now() - started;

  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));
  assert.equal(cache.safeSourceEnd, full.length);
  assert.ok(elapsed < 5_000, `label-$ streaming scan took ${elapsed.toFixed(1)}ms`);
});

it('renders images whose alt contains escaped brackets', () => {
  const cases = [
    {
      text: '![\\[alt\\] preview](https://example.com/x.png)',
      alt: '[alt] preview',
    },
    {
      text: '![\\[alt\\] preview][pic]\n\n[pic]: https://example.com/x.png',
      alt: '[alt] preview',
    },
    {
      text: '![visible][\\[topic\\]]\n\n[\\[topic\\]]: https://example.com/image.png',
      alt: 'visible',
    },
    {
      text: '![\\[topic\\]][]\n\n[\\[topic\\]]: https://example.com/image.png',
      alt: '[topic]',
    },
    {
      text: '![\\[topic\\]]\n\n[\\[topic\\]]: https://example.com/image.png',
      alt: '[topic]',
    },
  ];

  for (const { text, alt } of cases) {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(MarkdownBody, { text }),
    }));

    assert.match(markup, /<img\b[^>]*src="https:\/\/example\.com\//, text);
    assert.match(markup, new RegExp(`alt="${alt.replace(/[[\]]/g, '\\$&')}"`), text);
    assert.doesNotMatch(markup, /maka-math/, text);
    assert.doesNotMatch(markup, /MAKA_MATH/, text);
  }
});

it('keeps escaped image alt text identical between incremental and one-shot scans', () => {
  const full = '![\\[alt\\] preview](https://example.com/a.png)';
  const cache = createMarkdownMathCache();
  let incremental = '';
  for (let end = 1; end <= full.length; end++) {
    incremental = prepareMarkdownMath(full.slice(0, end), cache);
  }

  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: full }),
  }));

  assert.match(markup, /<img\b[^>]*src="https:\/\/example\.com\/a\.png"/);
  assert.match(markup, /alt="\[alt\] preview"/);
  assert.doesNotMatch(markup, /maka-math/);
  assert.doesNotMatch(markup, /MAKA_MATH/);
});

it('preserves links and images with labels past the defensive scan bound', () => {
  const longLink = `[\\[DISCUSS\\] ${'a'.repeat(4096)}](https://example.com/long)`;
  const linkMarkup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: longLink }),
  }));

  assert.match(linkMarkup, /<a\b[^>]*href="https:\/\/example\.com\/long"/);
  assert.match(linkMarkup, /\[DISCUSS\]/);
  assert.doesNotMatch(linkMarkup, /maka-math-display|katex-display/);

  const longImg = `![\\[alt\\] ${'b'.repeat(4096)}](https://example.com/y.png)`;
  const imgMarkup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: longImg }),
  }));

  assert.match(imgMarkup, /<img\b[^>]*src="https:\/\/example\.com\/y\.png"/);
  assert.match(imgMarkup, /alt="\[alt\] b/);
  assert.doesNotMatch(imgMarkup, /maka-math/);
  assert.doesNotMatch(imgMarkup, /MAKA_MATH/);
});

it('resolves labels far beyond any scan bound without a length cliff', () => {
  const bigLink = `[\\[DISCUSS\\] ${'a'.repeat(100_000)}](https://example.com/huge)`;
  const cache = createMarkdownMathCache();
  const prepared = prepareMarkdownMath(bigLink, cache);

  assert.equal(cache.safeSourceEnd, bigLink.length);

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: bigLink }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com\/huge"/);
  assert.match(markup, /\[DISCUSS\]/);
  assert.doesNotMatch(markup, /maka-math-display|katex-display/);
});

it('streams an unfinished label without rescanning from its opener', () => {
  const full = `[${'a'.repeat(128_000 - 1)}`;
  const cache = createMarkdownMathCache();
  const started = performance.now();
  let incremental = '';
  for (let end = 1024; end <= full.length; end += 1024) {
    incremental = prepareMarkdownMath(full.slice(0, end), cache);
  }
  const elapsed = performance.now() - started;

  assert.equal(incremental, full);
  assert.equal(cache.safeSourceEnd, 0);
  assert.ok(elapsed < 5_000, `unfinished label streaming took ${elapsed.toFixed(1)}ms`);
});

it('resolves a streamed label once its closer arrives', () => {
  const head = `[${'b'.repeat(64_000)}`;
  const cache = createMarkdownMathCache();
  for (let end = 1024; end <= head.length; end += 1024) {
    prepareMarkdownMath(head.slice(0, end), cache);
  }
  const full = `${head}](https://example.com/closed)`;
  const incremental = prepareMarkdownMath(full, cache);

  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));
  assert.equal(cache.safeSourceEnd, full.length);

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: full }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com\/closed"/);
});

it('streams an unfinished reference identifier without rescanning from its opener', () => {
  const head = `[visible][${'c'.repeat(64_000)}`;
  const cache = createMarkdownMathCache();
  const started = performance.now();
  let incremental = '';
  for (let end = 1024; end <= head.length; end += 1024) {
    incremental = prepareMarkdownMath(head.slice(0, end), cache);
  }
  if (head.length % 1024 !== 0) {
    incremental = prepareMarkdownMath(head, cache);
  }
  const elapsed = performance.now() - started;

  assert.equal(incremental, head);
  assert.equal(cache.safeSourceEnd, 0);
  assert.ok(elapsed < 5_000, `unfinished identifier streaming took ${elapsed.toFixed(1)}ms`);

  const id = 'c'.repeat(64_000);
  const full = `[visible][${id}]\n\n[${id}]: https://example.com/ref`;
  incremental = prepareMarkdownMath(full, cache);

  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));
  assert.equal(cache.safeSourceEnd, full.length);

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: full }),
  }));

  assert.match(markup, /<a\b[^>]*href="https:\/\/example\.com\/ref"/);
  assert.match(markup, />visible</);
});

it('reparses an earlier delimiter that closes after a pending label', () => {
  const cases = [
    // Unclosed code span, then its closer plus display math.
    { head: '`[', full: '`[` $$x$$' },
    // Unclosed inline math, then its closer plus display math.
    { head: '\\([x', full: '\\([x\\) $$y$$' },
    // Unclosed display math, then its closer plus display math.
    { head: '$$[', full: '$$[$$ $$y$$' },
  ];

  for (const { head, full } of cases) {
    const cache = createMarkdownMathCache();
    prepareMarkdownMath(head, cache);
    const incremental = prepareMarkdownMath(full, cache);

    assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()), head);
  }
});

it('does not rescan malformed link tails quadratically', () => {
  const input = '[x]('.repeat(32_000);
  const cache = createMarkdownMathCache();
  const started = performance.now();
  const prepared = prepareMarkdownMath(input, cache);
  const elapsed = performance.now() - started;

  assert.equal(prepared, input);
  assert.ok(elapsed < 1_000, `malformed link scan took ${elapsed.toFixed(1)}ms`);

  const streamedInput = '[x]('.repeat(16_000);
  const streamedCache = createMarkdownMathCache();
  const streamedStarted = performance.now();
  const chunkSize = streamedInput.length / 16;
  for (let end = chunkSize; end <= streamedInput.length; end += chunkSize) {
    assert.equal(prepareMarkdownMath(streamedInput.slice(0, end), streamedCache), streamedInput.slice(0, end));
  }
  const streamedElapsed = performance.now() - streamedStarted;

  assert.ok(streamedElapsed < 1_000, `streaming malformed link scan took ${streamedElapsed.toFixed(1)}ms`);
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

  for (const [locale, label] of [['en', 'Code'], ['zh-CN', '代码']] as const) {
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

it('renders settled math while keeping the live tail behind the display cursor', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'Stable \\( x + 1 \\) with a new delta',
    streaming: true,
    settledText: 'Stable \\( x + 1 \\)',
  }));

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

  assert.match(markup, />prefix ?</);
  assert.doesNotMatch(markup, /redacted|NEW/);
});

it('never settles half of a rewritten Unicode code point', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownBody, {
    text: 'same 😃 NEW',
    streaming: true,
    settledText: 'same 😀 old',
  }));

  assert.match(markup, />same ?</);
  assert.doesNotMatch(markup, /😃|NEW|�/u);
});
