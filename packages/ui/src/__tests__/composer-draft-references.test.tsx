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

test('empty-draft recovery follows mutations and lifetime, not navigation or final emptiness', async () => {
  const originals = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  let value = '';
  let references: readonly InlineReference[] = [];
  let draft!: ComposerDraftApi;
  function Probe({ draftKey }: { draftKey: string }) {
    draft = useComposerDraft({ text: { getValue: () => value, setValue: (text) => { value = text; } },
      draftKey, onDraftKeyChange() {}, hasPendingContext: true,
      references: { read: () => references, write: (next) => { references = next; } },
    });
    return null;
  }
  const render = (key: string) => act(() => root.render(<Probe draftKey={key} />));
  try {
    await render('a');
    const recovery = draft.captureEmptyDraft('a')!;
    const another = draft.captureEmptyDraft('a')!;
    another.release();
    assert.equal(another.isCurrent(), false);
    assert.equal(recovery.isCurrent(), true, 'one release does not abandon another live claim');
    await render('b');
    assert.equal(draft.captureEmptyDraft('a'), undefined, 'only the visible draft may start a local edit');
    draft.setDraft('b', 'B stays here');
    assert.equal(recovery.isCurrent(), true);
    const body = ' \n@file.ts ' + 'long '.repeat(25_600) + '\n ';
    const originalReferences: InlineReference[] = [{ kind: 'workspace_file', start: 2, value: '@file.ts', label: 'file.ts' }];
    recovery.restore(body, originalReferences, 'original');
    assert.equal(recovery.isCurrent(), false, 'a successful handoff cannot be repeated');
    assert.equal(value, 'B stays here');
    assert.equal(draft.getDraft('a'), body);
    assert.equal(draft.replacementMessageId('a'), 'original');
    await render('a');
    assert.equal(value, body);
    assert.deepEqual(references, originalReferences, 'lossless keyed restore does not trim or shift offsets');
    draft.clearDraft('a');
    const typed = draft.captureEmptyDraft('a')!;
    value = 'typed'; draft.saveCurrentDraft();
    value = ''; draft.saveCurrentDraft();
    assert.equal(typed.isCurrent(), false, 'typing then clearing cannot make an old claim current');
    const cleared = draft.captureEmptyDraft('a')!;
    draft.clearDraft('a');
    assert.equal(cleared.isCurrent(), false, 'explicitly clearing an already empty draft also counts');
    const bodyless = draft.captureEmptyDraft('a')!;
    bodyless.restore('', [], 'bodyless-original');
    assert.equal(draft.captureEmptyDraft('a'), undefined, 'an attachment-only replacement still owns its identity');
    draft.clearDraft('a');
    const unmounted = draft.captureEmptyDraft('a')!;
    await act(() => root.render(null));
    assert.equal(unmounted.isCurrent(), false);
    const staleOwner = draft.captureEmptyDraft('a')!;
    assert.equal(staleOwner.isCurrent(), false);
    await render('a');
    assert.equal(unmounted.isCurrent(), false, 'remount cannot revive the old owner');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, originals);
  }
});

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
  test(`an ${active ? 'active' : 'inactive'} replacement draft never reloads as unrelated persisted text`, async () => {
    const originals = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.querySelector('#root')!);
    const persisted = new Map([['edit', 'previous text'], ['other', 'ordinary draft']]);
    let value = '';
    let draft!: ComposerDraftApi;
    function Probe({ draftKey }: { draftKey: string }) {
      draft = useComposerDraft({
        text: { getValue: () => value, setValue: (next) => { value = next; } },
        draftKey, onDraftKeyChange() {}, hasPendingContext: true,
        persistence: {
          read: (key) => persisted.get(key ?? ''),
          write: (key, body) => { persisted.set(key ?? '', body); },
        },
      });
      return null;
    }
    const render = async (draftKey: string) => act(() => root.render(<Probe draftKey={draftKey} />));
    const restart = async (draftKey: string) => {
      await act(() => root.render(null));
      value = '';
      await render(draftKey);
    };
    try {
      await render(active ? 'edit' : 'other');
      draft.appendDraft('edit', 'original body', [], 'paused-original');
      assert.equal(persisted.get('edit'), '', 'also erase any earlier persisted body');
      if (!active) assert.equal(value, 'ordinary draft');
      await render('edit');
      assert.equal(value, 'previous text\n\noriginal body');
      value = '';
      draft.saveCurrentDraft();
      assert.equal(draft.replacementMessageId('edit'), 'paused-original', 'attachment-only edits still own the replacement');
      value = 'edited body';
      draft.saveCurrentDraft();
      await render('other');
      await render('edit');
      assert.equal(value, 'edited body', 'navigation preserves the live edit');
      assert.equal(persisted.get('edit'), '');
      draft.consumeReplacement('edit', 'another-original');
      assert.equal(persisted.get('edit'), '', 'an unrelated acknowledgement cannot make an edit persistent');
      await restart('edit');
      assert.equal(value, '', 'a new renderer must not restore the body without its replacement link');
      assert.equal(draft.replacementMessageId('edit'), undefined);
      await render('other');
      assert.equal(value, 'ordinary draft', 'ordinary persistence remains available');

      // Text typed during a successful send becomes an ordinary draft even
      // when the acknowledgement arrives after switching Sessions.
      draft.appendDraft('edit', 'original body', [], 'paused-original');
      await render('edit');
      value = 'new text typed while sending';
      draft.saveCurrentDraft();
      await render('other');
      draft.consumeReplacement('edit', 'paused-original');
      assert.equal(persisted.get('edit'), 'new text typed while sending');
      await restart('edit');
      assert.equal(value, 'new text typed while sending');
      assert.equal(draft.replacementMessageId('edit'), undefined);

      draft.appendDraft('edit', 'another edit', [], 'another-original');
      draft.clearDraft('edit');
      value = 'fresh ordinary draft';
      draft.saveCurrentDraft();
      assert.equal(persisted.get('edit'), value, 'abandoning an edit restores ordinary persistence');
    } finally {
      await act(() => root.unmount());
      Object.assign(globalThis, originals);
    }
  });

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


test('window handoff snapshots active and inactive drafts with references', async () => {
  const originals = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  let value = '';
  let references: readonly InlineReference[] = [];
  let draft!: ComposerDraftApi;
  function Probe({ draftKey }: { draftKey: string }) {
    draft = useComposerDraft({ text: { getValue: () => value, setValue: (next) => { value = next; } }, draftKey,
      onDraftKeyChange() {}, hasPendingContext: true,
      references: { read: () => references, write: (next) => { references = next; } } });
    return null;
  }
  try {
    await act(() => root.render(<Probe draftKey="a" />));
    const reference: InlineReference = { kind: 'workspace_file', value: '@file.ts', label: 'file.ts', start: 0 };
    draft.appendDraft('a', '@file.ts\ntext', [reference]);
    draft.setDraft('child', 'child unsent text');
    draft.setDraft('unrelated', 'B keeps working');
    // Capture the live editor even when no blur/save has fired yet.
    value += ' typed right before opening';
    const saved = draft.captureDrafts(['a', 'child']);
    assert.equal(saved[0]!.text, '@file.ts\ntext typed right before opening');
    assert.deepEqual(saved[0]!.references, [reference]);
    draft.clearDraft('a'); draft.clearDraft('child');
    assert.equal(draft.getDraft('unrelated'), 'B keeps working');
    await act(() => root.render(null));
    value = ''; references = [];
    await act(() => root.render(<Probe draftKey="child" />));
    draft.restoreDrafts(saved);
    assert.equal(value, 'child unsent text');
    assert.equal(draft.getDraft('a'), saved[0]!.text);
    await act(() => root.render(<Probe draftKey="a" />));
    assert.equal(value, saved[0]!.text);
    assert.deepEqual(references, [reference]);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, originals);
  }
});


test('handoff refuses draft-cache loss before changing existing text or references', async () => {
  const originals = { document: globalThis.document, window: globalThis.window, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  let value = ''; let draft!: ComposerDraftApi;
  function Probe() {
    draft = useComposerDraft({ text: { getValue: () => value, setValue: (next) => { value = next; } }, draftKey: 'b', onDraftKeyChange() {} });
    return null;
  }
  try {
    await act(() => root.render(<Probe />));
    value = 'x'.repeat(120_001);
    assert.throws(() => draft.captureDrafts(['b']), /existing draft cache/);
    assert.equal(value.length, 120_001);
    value = 'keep B';
    for (let i = 0; i < 32; i++) draft.setDraft(`existing-${i}`, `draft ${i}`);
    assert.throws(() => draft.restoreDrafts([{ draftKey: 'a', text: 'incoming A', references: [] }]), /cache is full/);
    assert.equal(value, 'keep B'); assert.equal(draft.getDraft('existing-0'), 'draft 0'); assert.equal(draft.getDraft('a'), '');
    assert.throws(() => draft.restoreDrafts([{ draftKey: 'a', text: 'edit', references: [], replacesMessageId: 'old' }]), /cache is full/);
    assert.equal(draft.getDraft('a'), '');
  } finally { await act(() => root.unmount()); Object.assign(globalThis, originals); }
});
