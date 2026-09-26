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
import { Composer, type ComposerSendMetadata } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { useComposerAttachments } from '../use-composer-attachments.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  KeyboardEvent: globalThis.KeyboardEvent,
  Node: globalThis.Node,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  Object.assign(globalThis, originalGlobals);
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type SendPath = 'submit' | 'follow-up-enter' | 'steer-enter';
const recoveryId = 'local-recovery:waiting-send';

async function harness(path: SendPath = 'submit') {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  window.getSelection = () => null;
  document.getSelection = () => null;
  const setAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function normalized(name: string, value: string) {
    return setAttribute.call(this, name === 'contentEditable' ? 'contenteditable' : name, value);
  };
  class KeyEvent extends window.Event {
    constructor(type: string, init: KeyboardEventInit = {}) {
      super(type, init);
      Object.assign(this, { key: 'Enter', code: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false }, init);
    }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Win32' } });
  Object.assign(globalThis, { document, window, KeyboardEvent: KeyEvent, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  const reference = deferred<boolean>();
  const admission = deferred<boolean>();
  const released: string[] = [];
  const events: string[] = [];
  const sends: Array<{ available: boolean; metadata?: ComposerSendMetadata }> = [];
  let attachments!: ReturnType<typeof useComposerAttachments>;
  let mounted = true;

  function Probe({ draftKey }: { draftKey: string }) {
    const staged = useComposerAttachments({
      draftKey,
      copy: {
        attachmentFailedTitle: 'Attachment failed', tryAgain: 'Try again',
        imageAttachmentNotDirectTitle: 'Image', imageAttachmentNotDirectDescription: 'Image context',
      },
      formatError: (_error, fallback) => fallback,
      toastApi: { error() {} },
      service: {
        pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
        previewApproval: async () => ({ ok: false, reason: 'not used' }),
      },
      releaseRecoveryAttachments: async (ids) => { released.push(...ids); },
    });
    attachments = staged;
    return <Composer
      draftKey={draftKey}
      streaming={path !== 'submit'}
      allowAttachmentOnlySend
      pendingAttachments={staged.pendingAttachments}
      onRemoveAttachment={staged.removeAttachment}
      retainSendContext={() => {
        events.push('retain');
        const endSend = staged.retainAttachments(staged.submittableAttachments);
        return () => { events.push('end'); endSend(); };
      }}
      waitForSessionReference={() => { events.push('wait'); return reference.promise; }}
      onSend={async (_text, metadata) => {
        const submitted = staged.pendingAttachments;
        sends.push({ available: !released.includes(recoveryId), metadata });
        const accepted = await admission.promise;
        if (accepted) staged.clearSubmittedContext(submitted);
        return accepted;
      }}
      onStop={() => undefined}
    />;
  }
  async function render(draftKey: string) {
    await act(() => root.render(<LocaleProvider locale="en"><Probe draftKey={draftKey} /></LocaleProvider>));
  }
  async function unmount() {
    if (!mounted) return;
    await act(() => root.unmount());
    mounted = false;
  }
  cleanup = async () => {
    await act(async () => { reference.resolve(false); admission.resolve(false); });
    await unmount();
    window.Element.prototype.setAttribute = setAttribute;
  };
  await render('original');
  await act(() => attachments.restoreMessageContext('original', undefined, {
    attachments: [], directoryReferences: [],
    stagedAttachments: [{ approvalId: recoveryId, name: 'recovered.txt', mimeType: 'text/plain', size: 1 }],
  }));
  return {
    released, events, sends, render, unmount,
    async submit() {
      await act(async () => {
        if (path === 'submit') {
          document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        } else {
          document.querySelector('[contenteditable="true"]')!.dispatchEvent(
            new KeyEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: path === 'steer-enter' }),
          );
        }
        await Promise.resolve();
      });
    },
    async removeAttachment() {
      const remove = document.querySelector('.maka-composer-attachment-token button');
      assert.ok(remove, 'the attachment remains removable while waiting');
      await act(() => remove.dispatchEvent(new window.Event('click', { bubbles: true })));
    },
    async resolveReference(ready: boolean) { await act(async () => reference.resolve(ready)); },
    async resolveAdmission(accepted: boolean) { await act(async () => admission.resolve(accepted)); },
  };
}

for (const path of ['submit', 'follow-up-enter', 'steer-enter'] as const) {
  test(`${path} retains removed recovery attachments before waiting for Session references`, async () => {
    const h = await harness(path);
    await h.submit();
    await h.removeAttachment();
    assert.deepEqual(h.released, [], 'an entered send owns its captured attachments before onSend starts');
    assert.deepEqual(h.events, ['retain', 'wait']);
    await h.resolveReference(true);
    assert.deepEqual(h.sends, [{ available: true, metadata: path === 'steer-enter' ? { followUpMode: 'steer' } : undefined }]);
    assert.deepEqual(h.released, [], 'the lease also covers asynchronous admission');
    await h.resolveAdmission(true);
    assert.deepEqual(h.released, [recoveryId]);
    assert.deepEqual(h.events, ['retain', 'wait', 'end']);
  });
}

for (const cancellation of ['reference-refused', 'draft-switch', 'unmount'] as const) {
  test(`${cancellation} ends the early send lease without calling onSend`, async () => {
    const h = await harness();
    await h.submit();
    if (cancellation === 'unmount') await h.unmount();
    else await h.removeAttachment();
    if (cancellation === 'draft-switch') await h.render('another');
    assert.deepEqual(h.released, []);
    await h.resolveReference(cancellation !== 'reference-refused');
    assert.deepEqual(h.sends, []);
    assert.deepEqual(h.released, [recoveryId]);
    assert.deepEqual(h.events, ['retain', 'wait', 'end']);
  });
}

test('reference refusal ends the lease but preserves still-staged attachments for retry', async () => {
  const h = await harness();
  await h.submit();
  await h.resolveReference(false);
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.released, []);
  assert.deepEqual(h.events, ['retain', 'wait', 'end']);
  await h.removeAttachment();
  assert.deepEqual(h.released, [recoveryId]);
});
