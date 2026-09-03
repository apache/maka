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

/**
 * Transcript markdown rhythm contract.
 *
 * Two failure modes, both SILENT — no error, no failing check, just spacing
 * that quietly stops being what the table declares. That is the whole reason
 * this file exists; a CSS selector that matches nothing never complains.
 *
 * 1. The table selects entirely on DOM Astryx generates at runtime —
 *    `data-density`, `astryx-markdown-heading` + `data-level`,
 *    `astryx-list-item`. Those names have a single upstream owner and appear
 *    in Maka only inside selectors, so an Astryx rename kills every rule at
 *    once. Astryx is bumped regularly (0.4.0 in #2983, 0.4.3 in flight, plus
 *    the Dependabot minor group), so this is a recurring event rather than a
 *    hypothetical.
 *
 * 2. Astryx's ListItem carries CONTROL row padding that `density` cannot reach
 *    from outside. That padding is what inverted the ladder in the first place
 *    (#2348: list items ~10px apart against 4px paragraphs, so same-level
 *    items read as further apart than separate paragraphs), and one rule
 *    neutralizes it. Lose that rule and the original defect returns.
 *
 * Deliberately NOT pinned: the ladder's declared VALUES and their order. A
 * reversed ladder has to be typed on purpose into four adjacent lines under a
 * comment that explains the order, and it is visible the moment anyone looks
 * at a transcript — unlike the two above, which are invisible until someone
 * measures. Same for the adjacent-sibling gap form, the `hr` rung, and the two
 * heading size tiers: those are how the table is written, not what it
 * promises.
 *
 * Also not pinned, and deliberately not testable from here: WHICH surfaces
 * ask for compact. That set spans workspaces — `chat-turn.tsx` here and
 * Artifact Preview in `apps/desktop` — so asserting it would mean a library
 * test reading application source, which is the dependency backwards. It is
 * documented where it is decided instead, next to the heading rules in
 * styles.css that the sharing actually matters for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from '../markdown-body.js';

const UI_SRC = resolve(import.meta.dirname, '..', '..', 'src');

const SAMPLE = ['## Heading two', '', 'A paragraph.', '', '1. First item', '2. Second item'].join('\n');

function compactMarkup(): string {
  return renderToStaticMarkup(<MarkdownBody text={SAMPLE} density="compact" />);
}

describe('transcript markdown rhythm', () => {
  it('emits the DOM hooks the rhythm table selects on', () => {
    const markup = compactMarkup();
    // Every rule in the table is prefixed with this, so it is the one hook
    // whose two halves — selector prefix and runtime attribute — nothing else
    // joins. Rename it and all compact spacing dies silently.
    assert.match(
      markup,
      /data-maka-contract="markdown"/,
      'the `data-maka-contract="markdown"` wrapper is gone. Every rule in the rhythm table ' +
        'is scoped on it, so all compact prose spacing and the heading scale are now dead.',
    );
    assert.match(
      markup,
      /<div[^>]*role="document"[^>]*data-density="compact"|<div[^>]*data-density="compact"[^>]*role="document"/,
      'the document root no longer carries `data-density="compact"`. Every rule in the ' +
        'rhythm table is scoped on it, so all compact prose spacing is now dead.',
    );
    assert.match(
      markup,
      /class="[^"]*\bastryx-markdown\b/,
      'the document root no longer carries the `astryx-markdown` class the table selects on',
    );
    assert.match(
      markup,
      /<h2[^>]*class="[^"]*\bastryx-markdown-heading\b/,
      'headings no longer carry `astryx-markdown-heading`; the transcript heading scale is dead',
    );
    assert.match(
      markup,
      /<h2[^>]*data-level="2"/,
      'headings no longer carry `data-level`. The table splits h1/h2 from h3-h6 on it, so ' +
        'without it every heading collapses to one tier — the exact defect #2348 replaced.',
    );
    assert.match(
      markup,
      /class="[^"]*\bastryx-list-item\b/,
      'list rows no longer carry `astryx-list-item`, so the rule below cannot reach them. ' +
        'If markdown lists stopped rendering through Astryx `List` that is good news, but ' +
        'the list rhythm needs re-measuring rather than silently inheriting whatever ' +
        'replaced it.',
    );
  });

  /**
   * The other half of the join above: the class is emitted AND something
   * spends its control padding. Markdown hands its list a hardcoded
   * `density="compact"` in both modes, so the row keeps a control's block
   * padding no matter what the caller asks for — the real list-item gap is
   * `padding + gap`, and only zeroing the padding makes `--md-gap-list` the
   * whole distance between two items.
   */
  it('neutralizes the ListItem control padding the ladder inverted on', async () => {
    const css = (await readFile(join(UI_SRC, 'styles.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = new RegExp(
      String.raw`\.astryx-markdown\[data-density="compact"\][^{]*\.astryx-list-item\s*\{([^}]*)\}`,
    ).exec(css);
    assert.ok(
      rule,
      'the compact surface no longer neutralizes `.astryx-list-item` padding. Astryx spaces ' +
        'a markdown list as a clickable row, which is what made same-level items read as ' +
        'further apart than separate paragraphs (#2348).',
    );
    assert.match(
      rule[1],
      /padding-block\s*:\s*0/,
      'ListItem block padding is no longer zeroed on the compact surface, so the real ' +
        'list-item gap is padding + gap and the declared ladder is not the spacing you get. ' +
        `Found: { ${rule[1].trim()} }`,
    );
  });
});
