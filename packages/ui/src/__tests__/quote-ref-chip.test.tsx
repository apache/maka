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
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { QuoteHoverCardContent, QuoteRefChip } from '../quote-ref-chip.js';
import { LocaleProvider } from '../locale-context.js';
import type { QuoteRef } from '@maka/core/events';

const originalGlobals = { document: globalThis.document, window: globalThis.window };
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const mountedRoots: Root[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container as unknown as Element);
  mountedRoots.push(root);
  return { container, root };
}

async function render(children: React.ReactNode) {
  const { container, root } = domRoot();
  await act(async () => {
    root.render(<LocaleProvider locale="en">{children}</LocaleProvider>);
  });
  return container;
}

const QUOTE: QuoteRef = {
  text: 'the deploy failed at step three',
  label: 'Assistant',
  sourceTurnId: 'turn-9',
};

test('the structured read names what was selected and what was said about it', async () => {
  const container = await render(
    <QuoteHoverCardContent quote={{ ...QUOTE, comment: 'is this the retry path?' }} />,
  );
  const card = container.querySelector('.maka-quote-hover-card');
  assert.ok(card);
  assert.match(card.textContent ?? '', /the deploy failed at step three/);
  assert.match(card.textContent ?? '', /Selected text/);
  assert.match(card.textContent ?? '', /Your comment/);
  assert.match(card.textContent ?? '', /is this the retry path\?/);
});

test('a quote with no note reads as the excerpt alone', async () => {
  const container = await render(<QuoteHoverCardContent quote={QUOTE} />);
  const card = container.querySelector('.maka-quote-hover-card');
  assert.ok(card);
  assert.match(card.textContent ?? '', /the deploy failed at step three/);
  assert.doesNotMatch(card.textContent ?? '', /Your comment/);
});

test('a note is marked on the chip that carries it', async () => {
  const withNote = await render(<QuoteRefChip quote={{ ...QUOTE, comment: 'noted' }} />);
  assert.equal(withNote.querySelectorAll('.maka-quote-chip-comment-icon').length, 1);

  const withoutNote = await render(<QuoteRefChip quote={QUOTE} />);
  assert.equal(withoutNote.querySelectorAll('.maka-quote-chip-comment-icon').length, 0);
});
