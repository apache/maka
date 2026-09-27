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
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  ComposerPromptSuggestionProvider,
  continuationDraftEligible,
  PROMPT_CONTINUATION_DEBOUNCE_MS,
  usePromptContinuation,
  type ComposerPromptSuggestionService,
} from '../prompt-suggestion.js';

const originals = { window: globalThis.window, document: globalThis.document,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  Object.assign(globalThis, { window: originals.window, document: originals.document, IS_REACT_ACT_ENVIRONMENT: originals.act });
});
const pause = () => act(() => new Promise((resolve) => setTimeout(resolve, PROMPT_CONTINUATION_DEBOUNCE_MS + 60)));

function harness(canContinue = () => true) {
  const { window, document } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.getElementById('root')!);
  let input = { sessionId: 's', streaming: false, blocked: false, text: '' };
  let latest!: ReturnType<typeof usePromptContinuation>;
  const requests: Array<string | undefined> = [];
  const pending: Array<(text: string | undefined) => void> = [];
  const service: ComposerPromptSuggestionService = { enabled: true, setEnabled() {},
    generate: async (_sessionId, prefix) => {
      requests.push(prefix);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  function Probe() { latest = usePromptContinuation({ ...input, canContinue }); return <span>{latest.text}</span>; }
  async function render(patch: Partial<typeof input> = {}) {
    input = { ...input, ...patch };
    await act(() => root!.render(<ComposerPromptSuggestionProvider service={service}><Probe /></ComposerPromptSuggestionProvider>));
  }
  return { render, latest: () => latest, requests: () => requests,
    resolve: async (text: string | undefined) => { await act(async () => { pending.shift()!(text); }); } };
}

test('a draft is eligible only with enough intent, no trailing space and no slash command', () => {
  assert.equal(continuationDraftEligible('帮我把这个函数'), true);
  assert.equal(continuationDraftEligible("Let's add"), true);
  for (const draft of ['abc', '帮我把 ', "Let's add ", '/skill fix', ''])
    assert.equal(continuationDraftEligible(draft), false, JSON.stringify(draft));
});

test('only a pause requests, with the latest draft, and the result shows for that draft only', async () => {
  const h = harness();
  await h.render({ text: '帮我把这' });
  await h.render({ text: '帮我把这个函数' });
  assert.deepEqual(h.requests(), [], 'typing within the pause sends nothing');
  await pause();
  assert.deepEqual(h.requests(), ['帮我把这个函数']);
  await h.resolve('改成异步的');
  assert.equal(h.latest().text, '改成异步的');
  await h.render({ text: '帮我把这个函数改' });
  assert.equal(h.latest().text, undefined, 'an edit hides the offer at once');
});

test('a result that arrives after the draft changed is discarded', async () => {
  const h = harness();
  await h.render({ text: '帮我把这个函数' });
  await pause();
  await h.render({ text: '帮我把这个类' });
  await h.resolve('改成异步的');
  assert.equal(h.latest().text, undefined);
});

test('Esc dismisses until the draft changes; streaming, blocked and editor state suppress requests', async () => {
  const h = harness();
  await h.render({ text: '帮我把这个函数' });
  await pause();
  await h.resolve('改成异步的');
  await act(() => h.latest().dismiss());
  assert.equal(h.latest().text, undefined);
  await h.render();
  await pause();
  assert.equal(h.requests().length, 1, 'a dismissed draft is not asked again');

  for (const patch of [{ streaming: true }, { blocked: true }]) {
    const g = harness();
    await g.render({ text: '帮我把这个函数', ...patch });
    await pause();
    assert.deepEqual(g.requests(), [], JSON.stringify(patch));
    await act(() => root!.unmount()); root = undefined;
  }
  const caretMoved = harness(() => false);
  await caretMoved.render({ text: '帮我把这个函数' });
  await pause();
  assert.deepEqual(caretMoved.requests(), [], 'the editor veto (caret, tokens, menu) is honoured');
});
