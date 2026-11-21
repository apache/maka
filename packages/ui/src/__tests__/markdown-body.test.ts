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
import { parseHTML } from 'linkedom';
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

it('image links use canonical destinations for titles, angle brackets and escaped parentheses', () => {
  for (const [text, destination] of [
    ['![Title](https://example.com/image.png "Screenshot title")', 'https://example.com/image.png'],
    ['![Angle](<https://example.com/image.png>)', 'https://example.com/image.png'],
    [String.raw`![Escaped](https://example.com/a\(1\).png)`, 'https://example.com/a(1).png'],
  ]) {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(MarkdownBody, { text, imageDisplay: 'link' }),
    }));
    assert.ok(markup.includes(`href="${destination}"`), markup);
    assert.doesNotMatch(markup, /<img\b|maka-markdown-image-resource|unsafe-scheme/);
  }
});

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

  assert.match(markup, /href="https:\/\/example\.com\/image\.png"/);
  assert.match(markup, />visible</);
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

  assert.match(markup, /href="https:\/\/example\.com\/a\.png"/);
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

    assert.match(markup, /href="https:\/\/example\.com\//, text);
    assert.match(markup, new RegExp(`>${alt.replace(/[[\]]/g, '\\$&')}<`), text);
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

  assert.match(markup, /href="https:\/\/example\.com\/a\.png"/);
  assert.match(markup, />\[alt\] preview</);
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

  assert.match(imgMarkup, /href="https:\/\/example\.com\/y\.png"/);
  assert.match(imgMarkup, />\[alt\] b/);
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

it('streams unfinished labels, identifiers, and tails in small chunks without quadratic slowdown', () => {
  const cases = [
    { name: 'unfinished label', head: `[${'a'.repeat(32_000 - 1)}` },
    { name: 'unfinished reference identifier', head: `[visible][${'c'.repeat(32_000)}` },
    { name: 'unfinished inline tail', head: `[visible](${'d'.repeat(32_000)}` },
  ];

  for (const { name, head } of cases) {
    const cache = createMarkdownMathCache();
    const started = performance.now();
    let incremental = '';
    const chunkSize = 16;
    for (let end = chunkSize; end <= head.length; end += chunkSize) {
      incremental = prepareMarkdownMath(head.slice(0, end), cache);
    }
    if (head.length % chunkSize !== 0) {
      incremental = prepareMarkdownMath(head, cache);
    }
    const elapsed = performance.now() - started;

    assert.equal(incremental, head, `Incremental content mismatch for ${name}`);
    assert.equal(cache.safeSourceEnd, 0, `safeSourceEnd should stay 0 while ${name} is open`);
    assert.ok(elapsed < 2_000, `Small chunk streaming for ${name} took ${elapsed.toFixed(1)}ms (expected < 2000ms)`);
  }
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

it('does not escape bare dollar signs when a chunk boundary splits before or inside link destinations', () => {
  const full = 'prefix ](https://example.com/search?query=$100&cost=$200)';
  const splitPoints = [
    'prefix ]',
    'prefix ](',
    'prefix ](https://example.com/search?query=',
  ];

  for (const head of splitPoints) {
    const cache = createMarkdownMathCache();
    prepareMarkdownMath(head, cache);
    const incremental = prepareMarkdownMath(full, cache);
    const oneshot = prepareMarkdownMath(full, createMarkdownMathCache());

    assert.equal(incremental, oneshot, `Failed at split point: "${head}"`);
    assert.doesNotMatch(incremental, /\\\$/, `Dollar should not be escaped in destination for head: "${head}"`);
  }

  const linkFull = '[search](https://example.com/search?query=$100&cost=$200)';
  const linkSplitPoints = [
    '[search]',
    '[search](',
    '[search](https://example.com/search?query=',
  ];

  for (const head of linkSplitPoints) {
    const cache = createMarkdownMathCache();
    prepareMarkdownMath(head, cache);
    const incremental = prepareMarkdownMath(linkFull, cache);
    const oneshot = prepareMarkdownMath(linkFull, createMarkdownMathCache());

    assert.equal(incremental, oneshot, `Failed at link split point: "${head}"`);
    assert.doesNotMatch(incremental, /\\\$/, `Dollar should not be escaped in link destination for head: "${head}"`);
  }

  // Incremental 1-byte streaming across entire string
  const cache = createMarkdownMathCache();
  let byteIncremental = '';
  for (let end = 1; end <= linkFull.length; end++) {
    byteIncremental = prepareMarkdownMath(linkFull.slice(0, end), cache);
  }
  assert.equal(byteIncremental, prepareMarkdownMath(linkFull, createMarkdownMathCache()));

  // Render via MarkdownBody to verify href is preserved without backslash escapes
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: linkFull }),
  }));
  assert.match(markup, /href="https:\/\/example\.com\/search\?query=\$100&amp;cost=\$200"/);
});

it('preserves normal prose processing and math when an unfinished label or inline tail remains incomplete', () => {
  const cases = [
    {
      source: 'prefix ](literal $x$ text',
      hasMath: false,
      expectedPattern: /\$x\$/,
    },
    {
      source: 'prefix ](literal \\(x+1\\) text',
      hasMath: true,
    },
    {
      source: 'prefix [literal $x$ text',
      hasMath: false,
      expectedPattern: /\$x\$/,
    },
    {
      source: 'prefix [literal \\(x+1\\) text',
      hasMath: true,
    },
    {
      source: 'prefix [label](literal $x$ text',
      hasMath: false,
      expectedPattern: /\$x\$/,
    },
    {
      source: 'prefix [label](literal \\(x+1\\) text',
      hasMath: true,
    },
  ];

  for (const { source, hasMath, expectedPattern } of cases) {
    const oneshot = prepareMarkdownMath(source, createMarkdownMathCache());
    const cache = createMarkdownMathCache();
    let streamed = '';
    for (let end = 1; end <= source.length; end++) {
      streamed = prepareMarkdownMath(source.slice(0, end), cache);
    }
    assert.equal(streamed, oneshot, `Incremental mismatch for "${source}"`);

    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(MarkdownBody, { text: source, streaming: false }),
    }));

    if (hasMath) {
      assert.match(markup, /class="maka-math maka-math-inline"/, `Missing KaTeX for "${source}"`);
      assert.match(markup, /class="katex"/, `Missing KaTeX for "${source}"`);
    } else {
      assert.doesNotMatch(markup, /class="maka-math/, `Unexpected KaTeX for "${source}"`);
      assert.doesNotMatch(markup, /class="katex/, `Unexpected KaTeX for "${source}"`);
      if (expectedPattern) {
        assert.match(markup, expectedPattern, `Expected pattern not found for "${source}"`);
      }
    }
  }

  // Multi-chunk streaming where an incomplete destination later closes
  const chunk1 = 'prefix [label](https://example.com/search?query=$100';
  const chunk2 = 'prefix [label](https://example.com/search?query=$100&cost=$200)';
  const cacheChunks = createMarkdownMathCache();
  prepareMarkdownMath(chunk1, cacheChunks);
  assert.equal(cacheChunks.safeSourceEnd, 'prefix '.length);

  const res2 = prepareMarkdownMath(chunk2, cacheChunks);
  assert.equal(res2, prepareMarkdownMath(chunk2, createMarkdownMathCache()));
  assert.doesNotMatch(res2, /\\\$/, 'Destination bare dollars must not be escaped after closing');

  const markupClosed = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: chunk2 }),
  }));
  assert.match(markupClosed, /href="https:\/\/example\.com\/search\?query=\$100&amp;cost=\$200"/);
});

it('preserves reference link tails across chunk boundaries and incremental streaming', () => {
  const full = 'prefix ][ref_$target]';
  const splitPoints = [
    'prefix ]',
    'prefix ][',
    'prefix ][ref_',
    'prefix ][ref_$target]',
  ];

  for (const head of splitPoints) {
    const cache = createMarkdownMathCache();
    prepareMarkdownMath(head, cache);
    const incremental = prepareMarkdownMath(full, cache);
    const oneshot = prepareMarkdownMath(full, createMarkdownMathCache());

    assert.equal(incremental, oneshot, `Failed at split point: "${head}"`);
  }

  // 1-byte streaming across unassociated reference tail
  const cache = createMarkdownMathCache();
  let incremental = '';
  for (let end = 1; end <= full.length; end++) {
    incremental = prepareMarkdownMath(full.slice(0, end), cache);
  }
  assert.equal(incremental, prepareMarkdownMath(full, createMarkdownMathCache()));

  // Reference link with target identifier containing $
  const linkText = '[label][ref_$target]\n\n[ref_$target]: https://example.com/path';
  const linkSplitPoints = [
    '[label]',
    '[label][',
    '[label][ref_',
  ];

  for (const head of linkSplitPoints) {
    const linkCache = createMarkdownMathCache();
    prepareMarkdownMath(head, linkCache);
    const inc = prepareMarkdownMath(linkText, linkCache);
    const oneshot = prepareMarkdownMath(linkText, createMarkdownMathCache());

    assert.equal(inc, oneshot, `Failed at link split point: "${head}"`);
  }

  // Incremental 1-byte streaming across complete reference link and definition
  const fullLinkCache = createMarkdownMathCache();
  let fullIncremental = '';
  for (let end = 1; end <= linkText.length; end++) {
    fullIncremental = prepareMarkdownMath(linkText.slice(0, end), fullLinkCache);
  }
  assert.equal(fullIncremental, prepareMarkdownMath(linkText, createMarkdownMathCache()));

  // Check valid reference link render in MarkdownBody
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: linkText }),
  }));
  assert.match(markup, /href="https:\/\/example\.com\/path"/);
  assert.match(markup, />label</);
  assert.doesNotMatch(markup, /maka-math/);
});

it('round-trips literal transport tokens across modes 0, 1, and 2 without KaTeX decoding', () => {
  const tokens = [
    { mode: '0 (inline)', token: '\uE000MAKA_MATH:0:78\uE001' },
    { mode: '1 (display)', token: '\uE000MAKA_MATH:1:78\uE001' },
    { mode: '2 (literal)', token: '\uE000MAKA_MATH:2:78\uE001' },
  ];

  for (const { mode, token } of tokens) {
    const full = `Prose before ${token} prose after`;

    // One-shot prepare
    const oneshot = prepareMarkdownMath(full, createMarkdownMathCache());

    // Incremental byte-by-byte streaming
    const cache = createMarkdownMathCache();
    let incremental = '';
    for (let end = 1; end <= full.length; end++) {
      incremental = prepareMarkdownMath(full.slice(0, end), cache);
    }

    assert.equal(incremental, oneshot, `Incremental mismatch for mode ${mode}`);

    // Render through MarkdownBody: ensure it does not decode into KaTeX math
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(MarkdownBody, { text: full }),
    }));

    assert.doesNotMatch(markup, /class="maka-math/, `KaTeX maka-math rendered for literal token mode ${mode}`);
    assert.doesNotMatch(markup, /class="katex/, `KaTeX class rendered for literal token mode ${mode}`);
  }
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
  const markup = renderImageMarkdown({
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
  });

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
    const markup = renderImageMarkdown({
      text: `![not-an-image](${src})`,
    });

    assert.doesNotMatch(markup, /<img\b/, src);
    assert.doesNotMatch(markup, /\bsrc=/, src);
  }
});

it('shows an attachment placeholder when no session reader is installed', () => {
  const markup = renderImageMarkdown({
    text: '![preview](maka://runtime/attachments/attachment-123)',
  });

  assert.match(markup, />preview</);
  assert.match(markup, /This image attachment is unavailable here/);
  assert.doesNotMatch(markup, /maka:\/\/runtime\/attachments/);
  assert.doesNotMatch(markup, /<img\b/);
});

function renderImageMarkdown(props: { text: string }) {
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, props),
  }));
}

it('preserves character pack attachment references through chat redaction', () => {
  const markup = renderImageMarkdown({
    text: '![sticker](maka://runtime/attachments/assistant_character_bf810d6e9d50f443d6e9aa0434b095d01eb978463c7096060ab5dae34d1cb530)',
  });
  // No reader here: reaching the attachment placeholder proves the reference
  // survived redaction and was parsed, rather than treated as an unknown URL.
  assert.match(markup, /This image attachment is unavailable here/);
  assert.doesNotMatch(markup, /This image address cannot be displayed here/);
});

it('keeps remote URLs out of image elements until a Host archive is available', () => {
  const markup = renderImageMarkdown({ text: '![preview](https://example.com/image.png)' });
  assert.doesNotMatch(markup, /<img\b|rel="preload"/);
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


it('memory citations route internally and never navigate as external URLs', () => {
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en', children: createElement(MakaUriContext.Provider, {
      value: () => {}, children: createElement(MarkdownBody, {
        text: '[原文](memory-original:r_abc123) [旧原文](memory-original:message-id:0)',
      }),
    }),
  }));
  assert.equal((markup.match(/data-maka-uri-kind="memory-original"/g) ?? []).length, 2);
  assert.doesNotMatch(markup, /unsafe-scheme|href="memory-original/);
});

it('treats orphan link destinations spanning a single newline as prose and translates math', () => {
  const dollarInput = 'prefix ](literal\n$x$)';
  const dollarOneShot = prepareMarkdownMath(dollarInput, createMarkdownMathCache());
  assert.equal(dollarOneShot, 'prefix ](literal\n\\$x\\$)');

  const dollarCache = createMarkdownMathCache();
  let dollarStream = '';
  for (let i = 1; i <= dollarInput.length; i++) {
    dollarStream = prepareMarkdownMath(dollarInput.slice(0, i), dollarCache);
  }
  assert.equal(dollarStream, 'prefix ](literal\n\\$x\\$)');

  const mathInput = 'prefix ](literal\n\\(x+1\\))';
  const mathOneShot = prepareMarkdownMath(mathInput, createMarkdownMathCache());
  assert.equal(mathOneShot, 'prefix ](literal\n$x+1$)');

  const mathCache = createMarkdownMathCache();
  let mathStream = '';
  for (let i = 1; i <= mathInput.length; i++) {
    mathStream = prepareMarkdownMath(mathInput.slice(0, i), mathCache);
  }
  assert.equal(mathStream, 'prefix ](literal\n$x+1$)');

  const escapedDollarInput = 'prefix ](literal\\\n$x$)';
  assert.equal(prepareMarkdownMath(escapedDollarInput, createMarkdownMathCache()), 'prefix ](literal\\\n\\$x\\$)');
  const escapedDollarCache = createMarkdownMathCache();
  let escapedDollarStream = '';
  for (let i = 1; i <= escapedDollarInput.length; i++) {
    escapedDollarStream = prepareMarkdownMath(escapedDollarInput.slice(0, i), escapedDollarCache);
  }
  assert.equal(escapedDollarStream, 'prefix ](literal\\\n\\$x\\$)');

  const escapedMathInput = 'prefix ](literal\\\n\\(x+1\\))';
  assert.equal(prepareMarkdownMath(escapedMathInput, createMarkdownMathCache()), 'prefix ](literal\\\n$x+1$)');
  const escapedMathCache = createMarkdownMathCache();
  let escapedMathStream = '';
  for (let i = 1; i <= escapedMathInput.length; i++) {
    escapedMathStream = prepareMarkdownMath(escapedMathInput.slice(0, i), escapedMathCache);
  }
  assert.equal(escapedMathStream, 'prefix ](literal\\\n$x+1$)');

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: mathInput }),
  }));
  assert.match(markup, /class="maka-math maka-math-inline"/);
  assert.match(markup, /class="katex"/);
});

it('preserves reference-identifier context during speculative streaming without leaking display math', () => {
  const openInput = 'prefix [label][\\[display\\]';
  const openOneShot = prepareMarkdownMath(openInput, createMarkdownMathCache());
  assert.equal(openOneShot, 'prefix [label][\\[display\\]');

  const openCache = createMarkdownMathCache();
  let openStream = '';
  for (let i = 1; i <= openInput.length; i++) {
    openStream = prepareMarkdownMath(openInput.slice(0, i), openCache);
    assert.doesNotMatch(openStream, /\$\$/, `chunk ${i} leaked into display math`);
  }
  assert.equal(openStream, openOneShot);

  const multiInput = 'prefix [label][\\[display\\] and \\[more\\]';
  const multiOneShot = prepareMarkdownMath(multiInput, createMarkdownMathCache());
  assert.equal(multiOneShot, 'prefix [label][\\[display\\] and \\[more\\]');
  const multiCache = createMarkdownMathCache();
  let multiStream = '';
  for (let i = 1; i <= multiInput.length; i++) {
    multiStream = prepareMarkdownMath(multiInput.slice(0, i), multiCache);
    assert.doesNotMatch(multiStream, /\$\$/, `multi chunk ${i} leaked into display math`);
  }
  assert.equal(multiStream, multiOneShot);

  const closedInput = 'prefix [label][\\[display\\]]';
  const closedOneShot = prepareMarkdownMath(closedInput, createMarkdownMathCache());
  const closedCache = createMarkdownMathCache();
  let closedStream = '';
  for (let i = 1; i <= closedInput.length; i++) {
    closedStream = prepareMarkdownMath(closedInput.slice(0, i), closedCache);
  }
  assert.equal(closedStream, closedOneShot);
  assert.doesNotMatch(closedStream, /\$\$/);

  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(MarkdownBody, { text: closedInput }),
  }));
  assert.doesNotMatch(markup, /maka-math-display|katex-display/);
});

it('renders display math after an unterminated reference identifier in completed messages', () => {
  const sources = [
    'para [a][unfinished\n\\[x^2\\]\n',
    'para [l][r\n\\[x^2\\]\n\nnext',
  ];

  for (const source of sources) {
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(MarkdownBody, { text: source, streaming: false }),
    }));
    assert.match(markup, /class="maka-math maka-math-display"/, source);
    assert.match(markup, /class="katex-display"/, source);

    const streamCache = createMarkdownMathCache();
    for (let end = 1; end <= source.length; end++) {
      prepareMarkdownMath(source.slice(0, end), streamCache);
    }
    const afterStreaming = prepareMarkdownMath(source, streamCache, { isComplete: true });
    const fresh = prepareMarkdownMath(source, createMarkdownMathCache(), { isComplete: true });
    assert.equal(afterStreaming, fresh, `Completed render diverged after streaming: ${source}`);
    assert.match(afterStreaming, /\$\$/, `Completed render lost display math: ${source}`);
  }
});

it('matches one-shot and incremental scans when an inline tail splits immediately after a newline', () => {
  const source = 'prefix [label](unfinished\n\nnext $x$ and \\(y\\)';
  const oneshot = prepareMarkdownMath(source, createMarkdownMathCache());

  for (let split = 1; split < source.length; split++) {
    if (source[split - 1] !== '\n') continue;
    const cache = createMarkdownMathCache();
    prepareMarkdownMath(source.slice(0, split), cache);
    assert.equal(
      prepareMarkdownMath(source, cache),
      oneshot,
      `Incremental mismatch after a newline split at ${split}`,
    );
  }
});

it('moves inline and standalone stickers outside prose without changing Markdown formatting', () => {
  const sticker = 'maka://runtime/attachments/assistant_sticker_' + 'a'.repeat(64);
  const markup = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', children:
    createElement(MarkdownBody, { text: `**Hello** ![Wave](${sticker}) again.\n\n- First\n- Second\n\n![Smile](${sticker})`, separateStickers: true }),
  }));
  const prose = markup.slice(markup.indexOf('maka-sticker-message-prose'), markup.indexOf('maka-message-stickers'));
  assert.match(prose, /<strong[^>]*>Hello<\/strong>/);
  assert.match(prose, /again\./);
  assert.match(prose, /<ul/);
  assert.doesNotMatch(prose, /maka-markdown-image-resource/);
  assert.equal((markup.slice(markup.indexOf('maka-message-stickers')).match(/maka-markdown-image-resource/g) ?? []).length, 2);
});

it('sticker-only messages have no empty prose bubble; code examples and ordinary images stay intact', () => {
  const sticker = 'maka://runtime/attachments/assistant_sticker_' + 'b'.repeat(64);
  const render = (text: string, imageDisplay?: 'link') => renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', children:
    createElement(MarkdownBody, { text, separateStickers: true, imageDisplay }),
  }));
  assert.match(render(`![Wave](${sticker})`), /class="maka-sticker-message-prose" hidden=""/);
  assert.doesNotMatch(render('`![Wave](' + sticker + ')`'), /maka-message-stickers/);
  assert.doesNotMatch(render('```md\n![Wave](' + sticker + ')\n```'), /maka-message-stickers/);
  assert.doesNotMatch(render(`![Photo](maka://runtime/attachments/ordinary-photo)`), /maka-message-stickers/);
  assert.doesNotMatch(render(`![Wave](${sticker})`, 'link'), /maka-message-stickers/);
  assert.match(render(`![Wave][s]\n\n[s]: ${sticker}`), /maka-message-stickers/);
});

it('authored summaries fold only prose, leaving stickers visible outside the disclosure', () => {
  const sticker = 'maka://runtime/attachments/assistant_sticker_' + 'c'.repeat(64);
  const markup = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', children:
    createElement(MarkdownBody, { summary: 'Brief preview', text: `**Full answer**\n\n- First\n- Second\n\n![Reaction](${sticker})`, separateStickers: true }),
  }));
  const { document } = parseHTML(markup);
  const body = document.querySelector('.maka-message-summary-body')!;
  assert.equal(body.hasAttribute('hidden'), true);
  assert.equal(body.querySelector('strong')?.textContent, 'Full answer');
  assert.ok(body.querySelector('ul'));
  assert.equal(body.querySelector('.maka-message-stickers'), null);
  const tray = document.querySelector('.maka-message-stickers')!;
  assert.ok(tray);
  assert.equal(tray.closest('[hidden]'), null);
  assert.equal(tray.closest('.maka-message-summary'), null);
});
