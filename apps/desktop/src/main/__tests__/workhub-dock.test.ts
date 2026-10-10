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
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import { LocaleProvider } from '@maka/ui';
import { createWorkHubEnablement, WorkHubEnablementProvider } from '../../renderer/application/contracts/workhub-workspace/workhub-enablement.js';
import { WorkHubDock, WorkHubServicesProvider, type WorkHubServices } from '../../renderer/features/workhub/index.js';
import type { WorkHubHost, WorkHubPresentationSnapshot } from '../../shared/workhub-presentation.js';

let root: Root | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

async function mount() {
  const { document, window } = parseHTML('<html><body><div id="root"></div><div popover><div class="maka-sidebar-hover-card">Task preview</div></div></body></html>');
  const overlay = document.querySelector<HTMLElement>('[popover]')!;
  const open = new Set<Element>();
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => selector.startsWith(':popover-open')
    ? [...open].filter(element => element.isConnected) : query(selector)) as typeof document.querySelectorAll;
  const matches = window.Element.prototype.matches;
  window.Element.prototype.matches = (function (this: Element, selector: string) {
    if (selector === ':popover-open') return open.has(this);
    if (selector === ':modal') return this.hasAttribute('data-modal');
    return matches.call(this, selector);
  }) as typeof matches;
  const bounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 200, y: 40, left: 200, top: 40, right: 1000, bottom: 800, width: 800, height: 760,
    toJSON: () => ({}),
  });
  const decode = deferred<void>();
  let decoded = false;
  const imageDecode = window.HTMLImageElement.prototype.decode;
  window.HTMLImageElement.prototype.decode = () => decode.promise.then(() => { decoded = true; });
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; };
  class Observer { observe() {} disconnect() {} }
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame: (id: number) => frames.delete(id), ResizeObserver: Observer, IntersectionObserver: Observer });
  const values = { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, values);
  restore = () => {
    window.Element.prototype.matches = matches;
    window.HTMLElement.prototype.getBoundingClientRect = bounds;
    if (imageDecode) window.HTMLImageElement.prototype.decode = imageDecode;
    else Reflect.deleteProperty(window.HTMLImageElement.prototype, 'decode');
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const hosts: WorkHubHost[] = [];
  const yieldedDecoded: boolean[] = [];
  const capture = deferred<string | undefined>();
  const restoration = deferred<void>();
  let holdRestore = false;
  let captures = 0;
  let publish!: (snapshot: WorkHubPresentationSnapshot) => void;
  const snapshot: WorkHubPresentationSnapshot = { placement: 'docked', floatingVisible: false, shortcutRegistered: true, rendererCrashed: false };
  const services = { presentation: {
    getSnapshot: async () => snapshot,
    subscribe: (handler: typeof publish) => { publish = handler; return () => {}; },
    setHost: async (host: WorkHubHost) => {
      hosts.push(host);
      if (host.occluded) { yieldedDecoded.push(decoded); return 'data:image/png;base64,late-frame'; }
      if (holdRestore && !host.occluded) await restoration.promise;
    },
    captureBackdrop: () => { captures++; return capture.promise; },
  } } as unknown as WorkHubServices;
  const enablement = createWorkHubEnablement({ read: async () => true, subscribeChanges: () => () => {} });
  root = createRoot(document.querySelector('#root')!);
  await act(async () => root!.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkHubEnablementProvider, { value: enablement },
      createElement(WorkHubServicesProvider, { services }, createElement(WorkHubDock, { workbar: { bottomOpen: false, rightCollapsed: true } }))),
  })));
  const frame = async (count = 1) => {
    for (let index = 0; index < count; index++) await act(async () => {
      const pending = [...frames];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    });
  };
  await frame();
  const toggle = (show: boolean) => act(async () => {
    const before = new window.Event('beforetoggle', { bubbles: true });
    Object.assign(before, { newState: show ? 'open' : 'closed' });
    overlay.dispatchEvent(before);
    if (show) open.add(overlay); else open.delete(overlay);
    overlay.dispatchEvent(new window.Event('toggle', { bubbles: true }));
  });
  return {
    document, overlay, hosts, yieldedDecoded, capture, decode, frame, toggle, snapshot, publish: (next: WorkHubPresentationSnapshot) => act(async () => publish(next)),
    get captures() { return captures; },
    image: () => document.querySelector<HTMLImageElement>('.workHubDockBackdrop'),
    holdRestore: () => { holdRestore = true; },
    restore: () => act(async () => restoration.resolve()),
  };
}

test('a sidebar preview prepares and decodes its frame before yielding, and keeps it until native restoration', async () => {
  const h = await mount();
  await h.toggle(true);
  assert.equal(h.captures, 1);
  assert.equal(h.overlay.style.visibility, 'hidden');
  await h.frame();
  assert.equal(h.hosts.at(-1)?.occluded, false);
  await act(async () => h.capture.resolve('data:image/png;base64,frame'));
  assert.ok(h.image());
  assert.equal(h.overlay.style.visibility, 'hidden', 'mounting an undecoded image cannot reveal the preview');
  await h.frame(2);
  assert.equal(h.overlay.style.visibility, 'hidden', 'elapsed frames cannot substitute for decoding');
  await act(async () => h.decode.resolve());
  await h.frame();
  assert.equal(h.overlay.style.visibility, 'hidden', 'decoded pixels must get a paint before the preview is exposed');
  await h.frame();
  assert.equal(h.overlay.style.visibility, '');
  await h.frame();
  assert.equal(h.hosts.at(-1)?.occluded, true);
  assert.deepEqual(h.yieldedDecoded, [true], 'native input yields only after the replacement frame has decoded');
  assert.equal(h.image()?.getAttribute('src'), 'data:image/png;base64,frame', 'a later capture cannot replace the decoded frame during the handoff');
  h.holdRestore();
  await h.toggle(false);
  await h.frame();
  assert.equal(h.hosts.at(-1)?.occluded, false);
  assert.ok(h.image(), 'an unacknowledged restoration keeps the backdrop');
  await h.restore();
  assert.ok(h.image(), 'the restoration acknowledgement is not itself a paint');
  await h.frame();
  assert.equal(!!h.image(), false);
});

for (const closeAt of ['capture', 'decode', 'handoff'] as const) {
  test(`closing a preview during ${closeAt} cannot yield input or leave a stale frame`, async () => {
    const h = await mount();
    await h.toggle(true);
    if (closeAt !== 'capture') await act(async () => h.capture.resolve('data:image/png;base64,frame'));
    if (closeAt === 'handoff') { await act(async () => h.decode.resolve()); await h.frame(2); }
    await h.toggle(false);
    await act(async () => { h.capture.resolve('data:image/png;base64,frame'); h.decode.resolve(); });
    await h.frame();
    assert.equal(h.overlay.hasAttribute('data-workhub-preview-pending'), false);
    assert.equal(!!h.image(), false);
    assert.equal(h.hosts.some((host) => host.occluded), false);
  });
}

for (const acknowledgement of ['before reopening', 'after reopening'] as const) {
  test(`restoration acknowledged ${acknowledgement} cannot clear the reopened preview's frame`, async () => {
    const h = await mount();
    await h.toggle(true);
    await act(async () => { h.capture.resolve('data:image/png;base64,frame'); h.decode.resolve(); });
    await h.frame(3);
    h.holdRestore();
    await h.toggle(false);
    await h.frame();
    if (acknowledgement === 'before reopening') await h.restore();
    await h.toggle(true);
    await h.frame(3);
    await h.restore();
    await h.frame();
    assert.equal(h.hosts.at(-1)?.occluded, true);
    assert.ok(h.image());
  });
}

for (const failure of ['capture', 'decode'] as const) {
  test(`a ${failure} failure releases the preview and retains the capture-optional overlay fallback`, async () => {
    const h = await mount();
    await h.toggle(true);
    await act(async () => {
      if (failure === 'capture') h.capture.reject(new Error('capture failed'));
      else { h.capture.resolve('data:image/png;base64,frame'); h.decode.reject(new Error('decode failed')); }
    });
    assert.equal(h.overlay.hasAttribute('data-workhub-preview-pending'), false);
    assert.equal(h.overlay.style.visibility, '');
    await h.frame();
    assert.equal(h.hosts.at(-1)?.occluded, true);
    await h.toggle(false);
    await h.frame();
    await h.frame();
    assert.equal(!!h.image(), false);
  });
}

test('cancelling a reopened preview cannot uncover an unacknowledged native restoration', async () => {
  const h = await mount();
  await h.toggle(true);
  await act(async () => { h.capture.resolve('data:image/png;base64,frame'); h.decode.resolve(); });
  await h.frame(3);
  h.holdRestore();
  await h.toggle(false);
  await h.frame();
  await h.toggle(true);
  await h.toggle(false);
  await h.frame();
  assert.ok(h.image(), 'the previous native restoration is still in flight');
  await h.restore();
  await h.frame();
  assert.equal(!!h.image(), false);
});

test('leaving the dock releases a pending preview and ignores the late image', async () => {
  const h = await mount();
  await h.toggle(true);
  await h.publish({ ...h.snapshot, placement: 'floating', floatingVisible: true });
  await act(async () => { h.capture.resolve('data:image/png;base64,frame'); h.decode.resolve(); });
  assert.equal(h.overlay.hasAttribute('data-workhub-preview-pending'), false);
  assert.equal(h.overlay.style.visibility, '');
  assert.equal(!!h.image(), false);
});

for (const removedAt of ['capture', 'displayed'] as const) {
  test(`removing the preview during ${removedAt} restores the dock without a closing event`, async () => {
    const h = await mount();
    await h.toggle(true);
    if (removedAt === 'displayed') {
      await act(async () => { h.capture.resolve('data:image/png;base64,frame'); h.decode.resolve(); });
      await h.frame(3);
    }
    await act(async () => h.overlay.remove());
    await h.frame();
    await act(async () => { h.capture.resolve('data:image/png;base64,frame'); h.decode.resolve(); });
    await h.frame();
    assert.equal(h.hosts.at(-1)?.occluded, false);
    assert.equal(h.overlay.hasAttribute('data-workhub-preview-pending'), false);
    assert.equal(!!h.image(), false);
  });
}
