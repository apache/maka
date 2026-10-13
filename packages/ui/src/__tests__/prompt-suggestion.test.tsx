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
import { ComposerPromptSuggestionProvider, usePromptSuggestion, type ComposerPromptSuggestionService } from '../prompt-suggestion.js';

const originals = { window: globalThis.window, document: globalThis.document,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  Object.assign(globalThis, { window: originals.window, document: originals.document, IS_REACT_ACT_ENVIRONMENT: originals.act });
});
function harness() {
  const { window, document } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.getElementById('root')!);
  let input = { sessionId: 's', streaming: false, blocked: false, text: '' };
  let latest!: ReturnType<typeof usePromptSuggestion>;
  let calls = 0;
  const pending: Array<(text: string | undefined) => void> = [];
  let service: ComposerPromptSuggestionService = { enabled: true, setEnabled() {},
    generate: async () => { calls++; return new Promise((resolve) => pending.push(resolve)); },
  };
  function Probe() { latest = usePromptSuggestion(input); return <span>{latest.text}</span>; }
  async function render(patch: Partial<typeof input> = {}, enabled = service.enabled) {
    input = { ...input, ...patch };
    if (service.enabled !== enabled) service = { ...service, enabled };
    await act(() => root!.render(<ComposerPromptSuggestionProvider service={service}><Probe /></ComposerPromptSuggestionProvider>));
  }
  return { render, latest: () => latest, calls: () => calls,
    resolve: async (text: string | undefined) => { await act(async () => { pending.shift()!(text); }); } };
}

test('only a witnessed completed response triggers a prediction; display and dismissal do not regenerate', async () => {
  const h = harness(); await h.render(); assert.equal(h.calls(), 0);
  await h.render({ streaming: true }); await h.render({ streaming: false });
  assert.equal(h.calls(), 1);
  await h.resolve('补上测试'); assert.equal(h.latest().text, '补上测试');
  await act(() => h.latest().dismiss()); assert.equal(h.latest().text, undefined);
  await h.render(); assert.equal(h.calls(), 1);
});

test('typing before a late result invalidates it even after the draft is cleared', async () => {
  const h = harness(); await h.render({ streaming: true }); await h.render({ streaming: false });
  await h.render({ text: '我想换个方向' }); await h.render({ text: '' });
  await h.resolve('补上测试'); assert.equal(h.latest().text, undefined); assert.equal(h.calls(), 1);
});

test('switching away and back, a new turn, disabling and blocked attachments all reject stale suggestions', async () => {
  for (const change of ['session', 'turn', 'disable', 'blocked']) {
    const h = harness(); await h.render({ streaming: true }); await h.render({ streaming: false });
    if (change === 'session') { await h.render({ sessionId: 'other' }); await h.render({ sessionId: 's' }); }
    if (change === 'turn') await h.render({ streaming: true });
    if (change === 'disable') await h.render({}, false);
    if (change === 'blocked') await h.render({ blocked: true });
    await h.resolve('补上测试'); assert.equal(h.latest().text, undefined, change);
    await act(() => root!.unmount()); root = undefined;
  }
});

test('disabled and nonempty composers never spend a prediction request', async () => {
  const h = harness(); await h.render({ streaming: true }, false); await h.render({ streaming: false }, false);
  assert.equal(h.calls(), 0);
  await h.render({ streaming: true, text: 'already typing' }, true); await h.render({ streaming: false });
  assert.equal(h.calls(), 0);
});
