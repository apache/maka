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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { InlineReference } from '@maka/core/events';
import { useComposerDraft, type ComposerDraftApi } from '../use-composer-draft.js';

test('keyed draft appends preserve file reference offsets, isolation and clearing', async () => {
  const originals = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  let value = '';
  let references: readonly InlineReference[] = [];
  let draft!: ComposerDraftApi;
  const text = { getValue: () => value, setValue: (next: string) => { value = next; } };
  function Probe({ draftKey }: { draftKey: string }) {
    draft = useComposerDraft({ text, draftKey, onDraftKeyChange() {},
      references: { read: () => references, write: (next) => { references = next; } },
    });
    return null;
  }
  const render = async (draftKey: string) => act(() => root.render(<Probe draftKey={draftKey} />));
  try {
    await render('a');
    draft.setDraft('a', 'old @old.ts  ', [{ kind: 'workspace_file', value: '@old.ts', label: 'old.ts', start: 4 }]);
    await render('b');
    draft.setDraft('b', 'unrelated');
    draft.appendDraft('a', '  check @src/index.ts  ', [{ kind: 'workspace_file', value: '@src/index.ts', label: 'index.ts', start: 8 }], 'paused-original');
    assert.equal(draft.replacementMessageId('a'), 'paused-original');
    assert.equal(draft.replacementMessageId('b'), undefined);
    assert.equal(value, 'unrelated');
    assert.deepEqual(references, []);
    await render('a');
    draft.saveCurrentDraft('edited @old.ts\n\ncheck @src/index.ts');
    assert.equal(draft.replacementMessageId('a'), 'paused-original', 'typing preserves replacement ownership');
    assert.equal(value, 'old @old.ts\n\ncheck @src/index.ts');
    assert.deepEqual(references.map(({ value, start }) => ({ value, start })), [
      { value: '@old.ts', start: 4 }, { value: '@src/index.ts', start: 19 },
    ]);
    draft.clearDraft('a');
    assert.equal(draft.replacementMessageId('a'), undefined);
    assert.deepEqual(references, []);
    await render('b');
    await render('a');
    assert.equal(value, '');
    assert.deepEqual(references, []);
    // No reference may survive a replacement just because the text matches.
    draft.appendDraft('a', '@same.ts', [{ kind: 'workspace_file', value: '@same.ts', label: 'same.ts', start: 0 }]);
    draft.setDraft('a', '@same.ts');
    assert.deepEqual(references, []);
    draft.appendDraft('a', 'original', [], 'evicted-original');
    await render('b');
    for (let index = 0; index < 33; index++) draft.setDraft(`other-${index}`, 'other draft');
    await render('a');
    assert.equal(value, '');
    assert.equal(draft.replacementMessageId('a'), undefined, 'evicting text also abandons replacement ownership');
    value = 'unrelated new message';
    draft.saveCurrentDraft();
    assert.equal(draft.replacementMessageId('a'), undefined);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, originals);
  }
});

for (const active of [true, false]) {
  test(`oversized replacement restored to an ${active ? 'active' : 'inactive'} draft keeps its body and references`, async () => {
    const originals = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.querySelector('#root')!);
    let value = '';
    let references: readonly InlineReference[] = [];
    let draft!: ComposerDraftApi;
    const text = { getValue: () => value, setValue: (next: string) => { value = next; } };
    function Probe({ draftKey }: { draftKey: string }) {
      draft = useComposerDraft({ text, draftKey, onDraftKeyChange() {},
        references: { read: () => references, write: (next) => { references = next; } },
      });
      return null;
    }
    const render = async (draftKey: string) => act(() => root.render(<Probe draftKey={draftKey} />));
    const reference: InlineReference = { kind: 'workspace_file', value: '@src/keep.ts', label: 'keep.ts', start: 0 };
    const prefix = `${reference.value}\n`;
    const body = prefix + 'x'.repeat(128_000 - prefix.length);
    try {
      await render(active ? 'edit' : 'other');
      if (!active) draft.setDraft('other', 'unrelated draft');
      draft.appendDraft('edit', body, [reference], 'paused-original');
      assert.equal(draft.getDraft('edit').length, body.length, 'the first cache write must retain the full edit');
      if (!active) assert.equal(value, 'unrelated draft');
      await render('other');
      await render('edit');
      assert.equal(value.length, body.length, 'switching sessions must not truncate a replacement');
      assert.equal(value, body);
      assert.deepEqual(references, [reference]);
      assert.equal(draft.replacementMessageId('edit'), 'paused-original');

      draft.appendDraft('edit', 'additional context');
      draft.saveCurrentDraft();
      await render('other');
      await render('edit');
      assert.equal(value, `${body}\n\nadditional context`);
      assert.deepEqual(references, [reference]);
      assert.equal(draft.replacementMessageId('edit'), 'paused-original');

      // Abandoning the edit restores the normal draft policy and drops references.
      draft.clearDraft('edit');
      assert.equal(draft.replacementMessageId('edit'), undefined);
      assert.deepEqual(references, []);
      draft.setDraft('edit', body, [reference]);
      await render('other');
      await render('edit');
      assert.equal(value.length, 120_000);
      assert.equal(value, body.slice(-120_000));
      assert.deepEqual(references, []);

      // Whole-entry eviction must still abandon even an oversized replacement.
      draft.appendDraft('evicted-edit', body, [reference], 'evicted-original');
      for (let index = 0; index < 32; index++) draft.setDraft(`other-${index}`, 'another draft');
      assert.equal(draft.getDraft('evicted-edit'), '');
      assert.equal(draft.replacementMessageId('evicted-edit'), undefined);
    } finally {
      await act(() => root.unmount());
      Object.assign(globalThis, originals);
    }
  });
}
