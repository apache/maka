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
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import { normalizeSessionSendCommand } from '../permission-response-guard.js';
import {
  useComposerAttachments,
  type ComposerAttachmentService,
} from '../../renderer/use-composer-attachments.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

type Picker = NonNullable<ComposerAttachmentService['pickDirectory']>;
type Options = { draftKey: string; hostId?: string; pick: Picker };
type State = ReturnType<typeof useComposerAttachments>;
const reference = { hostId: 'host-a', path: '/workspace/source' };

async function mount(initial: Partial<Options> = {}) {
  const { root } = installReactRenderer();
  let state!: State;
  const errors: string[] = [];
  let options: Options = {
    draftKey: 'draft-a',
    hostId: 'host-a',
    pick: async () => ({ ok: true, reference }),
    ...initial,
  };
  function Probe() {
    state = useComposerAttachments({
      draftKey: options.draftKey,
      directoryHostId: options.hostId,
      service: {
        pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
        previewApproval: async () => ({ ok: false, reason: 'not used' }),
        pickDirectory: options.pick,
      },
      toastApi: { error: (title, description) => errors.push(description ?? title) },
    });
    return null;
  }
  const render = async (patch: Partial<Options> = {}) => {
    options = { ...options, ...patch };
    await act(() => root.render(createElement(LocaleProvider, { locale: 'en', children: createElement(Probe) })));
  };
  await render();
  return { state: () => state, render, errors };
}

test('directory picker cancellation, duplicates and removal leave the draft consistent', async () => {
  const probe = await mount({ pick: async () => ({ ok: false, reason: 'cancelled' }) });
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  assert.deepEqual(probe.state().pendingDirectories, []);
  await probe.render({ pick: async () => ({ ok: true, reference }) });
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  assert.deepEqual(probe.state().pendingDirectories, [reference]);
  await act(() => probe.state().directoryComposerProps.onRemoveDirectory(0));
  assert.deepEqual(probe.state().pendingDirectories, []);
  assert.deepEqual(probe.errors, []);
});

test('discards a picker reply after its draft or Host changes', async () => {
  for (const patch of [{ draftKey: 'draft-b' }, { hostId: 'host-b' }]) {
    let resolve!: (result: Awaited<ReturnType<Picker>>) => void;
    const pending = new Promise<Awaited<ReturnType<Picker>>>((settle) => { resolve = settle; });
    const probe = await mount({ pick: () => pending });
    let picked!: Promise<void>;
    await act(() => { picked = probe.state().directoryComposerProps.onPickDirectory!(); });
    await probe.render(patch);
    await act(async () => { resolve({ ok: true, reference }); await picked; });
    assert.deepEqual(probe.state().pendingDirectories, []);
  }
});

test('rejects a foreign Host picker result and does not pick without a local Host', async () => {
  let picks = 0;
  const probe = await mount({ hostId: undefined, pick: async () => {
    picks += 1;
    return { ok: true, reference: { ...reference, hostId: 'host-b' } };
  } });
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  assert.equal(picks, 0);
  await probe.render({ hostId: 'host-a' });
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  assert.equal(probe.errors.length, 1);
  assert.deepEqual(probe.state().pendingDirectories, []);
});

test('caps concurrent picker results and clearing a submitted draft keeps newer references', async () => {
  let sequence = 0;
  const probe = await mount({ pick: async () => ({
    ok: true, reference: { ...reference, path: '/workspace/' + ++sequence },
  }) });
  const pick = probe.state().directoryComposerProps.onPickDirectory!;
  await act(() => Promise.all(Array.from({ length: 6 }, pick)).then(() => undefined));
  assert.equal(probe.state().pendingDirectories.length, 4);
  assert.equal(probe.state().directoryComposerProps.onPickDirectory, undefined);
  const clearSubmitted = probe.state().clearSubmittedContext;
  await act(() => probe.state().directoryComposerProps.onRemoveDirectory(0));
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  await probe.render({ draftKey: 'draft-b' });
  await act(() => probe.state().directoryComposerProps.onPickDirectory!());
  await act(() => clearSubmitted());
  assert.equal(probe.state().pendingDirectories.length, 1, 'must not clear a different draft');
  await probe.render({ draftKey: 'draft-a' });
  assert.equal(probe.state().pendingDirectories.length, 1, 'must not clear a reference added after send');
});

test('IPC validates directory references without turning them into attachments or permissions', () => {
  const normalized = normalizeSessionSendCommand({
    type: 'send', text: 'inspect', directoryReferences: [reference],
  });
  assert.deepEqual(normalized?.directoryReferences, [reference]);
  assert.equal(normalized?.attachmentItems, undefined);
  assert.notEqual(normalized?.directoryReferences?.[0], reference);
  for (const references of [
    [{ ...reference, path: '../outside' }],
    [{ ...reference, grant: 'read' }],
    Array.from({ length: 5 }, () => reference),
  ]) {
    assert.throws(() => normalizeSessionSendCommand({
      type: 'send', text: 'inspect', directoryReferences: references,
    }), /Invalid directory references/);
  }
});
