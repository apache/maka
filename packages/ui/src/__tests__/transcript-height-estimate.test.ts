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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { estimateTranscriptText, type TranscriptHeightProfile } from '../transcript-height-estimate.js';
import { useTranscriptKnownSpace } from '../use-transcript-known-space.js';

const profile: TranscriptHeightProfile = {
  width: 100, font: 10, line: 16, gap: 12, chrome: 30,
  userFont: 10, userLine: 14, userPadding: 20, userInset: 20,
  code: { line: 14, chrome: 40 },
};

test('paragraph wrapping follows the sampled width and keeps explicit block gaps', () => {
  const text = '中文内容'.repeat(5);
  assert.equal(estimateTranscriptText(text, profile), 32);
  assert.equal(estimateTranscriptText(text, { ...profile, width: 50 }), 64);
  assert.equal(estimateTranscriptText('第一段\n\n第二段', profile), 44);
});

test('fenced code uses measured line geometry without interpreting its Markdown-like content', () => {
  assert.equal(estimateTranscriptText('```ts\n# not a heading\n[1, 2]\n```', profile), 68);
  assert.equal(estimateTranscriptText('~~~~text\n```\n~~~~', profile), 54);
  assert.equal(estimateTranscriptText('```ts\nvalue\n```', { ...profile, code: undefined }), undefined);
});

test('unsupported structures and unfinished fences leave sizing to the fallback and real measurement', () => {
  for (const text of [
    '# Heading', '- item', '> quote', '[link](https://example.com)', '![image](a.png)',
    '| table |', '$x$', '```mermaid\ngraph TD\n```', '```ts\nunfinished',
    'first  \nsecond', '    indented code', 'first\n---',
  ]) assert.equal(estimateTranscriptText(text, profile), undefined, text);
});

test('range trimming preserves measurements while new estimates affect only unmeasured rows', async () => {
  const old = { window: globalThis.window, document: globalThis.document };
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldAct = environment.IS_REACT_ACT_ENVIRONMENT;
  const { window, document } = parseHTML('<main></main>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('main')!);
  const scrollRef = { current: null };
  let sizes!: ReturnType<typeof useTranscriptKnownSpace>;
  function Probe(props: { session: string; estimates: ReadonlyMap<string, number> }) {
    sizes = useTranscriptKnownSpace(scrollRef, props.session, [...props.estimates.keys()], true, props.estimates);
    return null;
  }
  const render = async (entries: Array<[string, number]>, session = 'one') => {
    await act(() => root.render(createElement(Probe, { session, estimates: new Map(entries) })));
  };
  try {
    await render([['a', 100], ['b', 200]]);
    assert.equal(sizes.height('a'), 100);
    sizes.measure('a', 333);
    await render([['a', 150], ['b', 250]]);
    assert.equal(sizes.height('a'), 333);
    assert.equal(sizes.height('b'), 250);
    await render([['b', 250], ['c', 500]]);
    assert.equal(sizes.beforeHeight, 333);
    assert.equal(sizes.height('c'), 500);
    await render([['c', 550]]);
    assert.equal(sizes.beforeHeight, 583);
    await render([['b', 275], ['c', 600]], 'two');
    assert.equal(sizes.beforeHeight, 0);
    assert.equal(sizes.height('b'), 275);
    sizes.measure('b', 0);
    await render([['b', 400], ['c', 600]], 'two');
    assert.equal(sizes.height('b'), 0);
    await render([['c', 600]], 'two');
    assert.equal(sizes.beforeHeight, 0);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, old);
    environment.IS_REACT_ACT_ENVIRONMENT = oldAct;
  }
});
