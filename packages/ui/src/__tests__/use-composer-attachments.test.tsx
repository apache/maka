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
import { afterEach, beforeEach, test } from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  useComposerAttachments,
  type ComposerAttachmentService,
} from '../use-composer-attachments.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  Image: globalThis.Image,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT,
};
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
const roots = new Set<ReturnType<typeof createRoot>>();
const createdUrls: string[] = [];
const decodedUrls: string[] = [];
let decode: () => Promise<void>;

beforeEach(() => {
  const { document, window } = parseHTML('<body></body>');
  Object.assign(globalThis, {
    document,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
    Image: class {
      src = '';
      decode() {
        decodedUrls.push(this.src);
        return decode();
      }
    },
  });
  decode = async () => {};
  URL.createObjectURL = (blob) => {
    const url = createObjectURL(blob);
    createdUrls.push(url);
    return url;
  };
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.clear();
  // Also clean up when an assertion fails against a leaking implementation.
  for (const url of createdUrls.splice(0)) revokeObjectURL(url);
  decodedUrls.length = 0;
  URL.createObjectURL = createObjectURL;
  Object.assign(globalThis, originalGlobals);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function imageFile(): File {
  const bytes = new Uint8Array(1024 * 1024);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], 'preview.png', { type: 'image/png' });
}

async function mount(service: Partial<ComposerAttachmentService> = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  let state!: ReturnType<typeof useComposerAttachments>;
  const notices: string[] = [];
  const errors: string[] = [];
  function Probe({ draftKey, hidden }: { draftKey: string; hidden: boolean }) {
    state = useComposerAttachments({
      draftKey,
      copy: {
        attachmentFailedTitle: 'Failed',
        tryAgain: 'Try again',
        imageAttachmentNotDirectTitle: 'Image',
        imageAttachmentNotDirectDescription: 'Image notice',
      },
      formatError: String,
      toastApi: { error: (title) => errors.push(title) },
      service: {
        pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
        previewApproval: async () => ({ ok: false, reason: 'unavailable' }),
        ...service,
      },
      imageNotice: { supportsVision: () => false, notify: (title) => notices.push(title) },
    });
    return <div hidden={hidden} />;
  }
  async function render(draftKey = 'draft-a', hidden = false) {
    await act(() => root.render(<StrictMode><Probe draftKey={draftKey} hidden={hidden} /></StrictMode>));
  }
  await render();
  return {
    state: () => state,
    render,
    notices,
    errors,
    async unmount() {
      await act(() => root.unmount());
      roots.delete(root);
    },
  };
}

test('keeps live draft previews across hiding and switching, then revokes removed items', async () => {
  const probe = await mount();
  await act(() => probe.state().attachFilePaths([imageFile()]));
  const url = probe.state().pendingAttachments[0]?.previewUrl;
  assert.ok(url);
  assert.ok(url.startsWith('blob:'));
  await probe.render('draft-a', true);
  assert.equal((await fetch(url)).status, 200);
  await probe.render('draft-b');
  assert.deepEqual(probe.state().pendingAttachments, []);
  assert.equal((await fetch(url)).status, 200);
  await probe.render('draft-a');
  assert.equal(probe.state().pendingAttachments[0]?.previewUrl, url);
  await act(() => probe.state().removeAttachment(0));
  assert.deepEqual(probe.state().pendingAttachments, []);
  await assert.rejects(fetch(url));
});

test('repeated composer unmounts release every completed Blob preview', async () => {
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const probe = await mount();
    await act(() => probe.state().attachFilePaths([imageFile()]));
    const url = probe.state().pendingAttachments[0]?.previewUrl;
    assert.ok(url);
    assert.equal((await (await fetch(url)).arrayBuffer()).byteLength, 1024 * 1024);
    await probe.unmount();
    assert.equal(probe.state().imageNoticeLifecycle.stagedKeys.size, 0);
  }
  assert.equal(createdUrls.length, 3);
  for (const url of createdUrls) await assert.rejects(fetch(url));
});

test('unmount releases a decoding Blob and stops the remaining preview batch', async () => {
  const decoding = deferred<void>();
  decode = () => decoding.promise;
  const probe = await mount();
  await act(() => probe.state().attachFilePaths([imageFile(), imageFile()]));
  assert.equal(createdUrls.length, 1);
  const url = createdUrls[0]!;
  await probe.unmount();
  await assert.rejects(fetch(url));
  await act(async () => { decoding.resolve(); });
  assert.equal(createdUrls.length, 1);
  assert.equal(decodedUrls.length, 1);
  assert.equal(probe.state().imageNoticeLifecycle.stagedKeys.size, 0);
});

test('removing a decoding image releases its Blob before decode settles', async () => {
  const decoding = deferred<void>();
  decode = () => decoding.promise;
  const probe = await mount();
  await act(() => probe.state().attachFilePaths([imageFile()]));
  const url = createdUrls[0]!;
  await act(() => probe.state().removeAttachment(0));
  await assert.rejects(fetch(url));
  await act(async () => { decoding.resolve(); });
  assert.deepEqual(probe.state().pendingAttachments, []);
});

test('a picker resolving after unmount cannot repopulate staging or read previews', async () => {
  const picking = deferred<Awaited<ReturnType<ComposerAttachmentService['pickFiles']>>>();
  let previewReads = 0;
  const probe = await mount({
    pickFiles: () => picking.promise,
    previewApproval: async () => {
      previewReads += 1;
      return { ok: true, mimeType: 'image/png', base64: 'aW1n' };
    },
  });
  const picked = probe.state().pickAttachments();
  await probe.unmount();
  await act(async () => {
    picking.resolve({
      ok: true,
      files: [{ approvalId: 'approval', name: 'preview.png', mimeType: 'image/png', size: 3 }],
    });
    await picked;
  });
  assert.equal(previewReads, 0);
  assert.equal(probe.state().imageNoticeLifecycle.stagedKeys.size, 0);
  assert.deepEqual(probe.notices, []);
  assert.deepEqual(probe.errors, []);
});

test('a MIME sniff resolving after unmount cannot create previews or staging identities', async () => {
  const sniffing = deferred<ArrayBuffer>();
  const file = imageFile();
  const prefix = await file.slice(0, 16).arrayBuffer();
  file.slice = () => {
    const blob = new Blob();
    blob.arrayBuffer = () => sniffing.promise;
    return blob;
  };
  const probe = await mount();
  const attached = probe.state().attachFilePaths([file]);
  await probe.unmount();
  await act(async () => {
    sniffing.resolve(prefix);
    await attached;
  });
  assert.deepEqual(createdUrls, []);
  assert.equal(probe.state().imageNoticeLifecycle.stagedKeys.size, 0);
  assert.deepEqual(probe.notices, []);
});

test('an approval preview resolving after unmount neither decodes nor reads the next image', async () => {
  const previewing = deferred<Awaited<ReturnType<ComposerAttachmentService['previewApproval']>>>();
  let previewReads = 0;
  const probe = await mount({
    pickFiles: async () => ({
      ok: true,
      files: ['first', 'second'].map((approvalId) => ({
        approvalId, name: `${approvalId}.png`, mimeType: 'image/png', size: 3,
      })),
    }),
    previewApproval: () => {
      previewReads += 1;
      return previewing.promise;
    },
  });
  await act(() => probe.state().pickAttachments());
  assert.equal(previewReads, 1);
  await probe.unmount();
  await act(async () => { previewing.resolve({ ok: true, mimeType: 'image/png', base64: 'aW1n' }); });
  assert.equal(previewReads, 1);
  assert.deepEqual(decodedUrls, []);
});
