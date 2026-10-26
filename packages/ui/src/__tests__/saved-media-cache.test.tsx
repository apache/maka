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
  SessionAttachmentProvider,
  type ReadAttachmentBytes,
} from '../attachment-image.js';
import { LocaleProvider } from '../locale-context.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

test('repeated images and virtualized remounts share a bounded saved-image cache', async () => {
  const { SessionMediaImage } = await import('../session-media-image.js');
  const { container, root } = domRoot();
  let reads = 0;
  const readBytes: ReadAttachmentBytes = async () => {
    reads++;
    return { ok: true, base64: 'AAAA', mimeType: 'image/png' };
  };
  const render = (visible: boolean) => root.render(<LocaleProvider locale="en"><SessionAttachmentProvider sessionId="session-1" readBytes={readBytes}>
    {visible && <><SessionMediaImage src="maka://runtime/attachments/image-1" alt="shared" /><SessionMediaImage src="maka://runtime/attachments/image-1" alt="same image" /></>}
  </SessionAttachmentProvider></LocaleProvider>);
  await act(async () => render(true));
  assert.equal(container.querySelectorAll('img').length, 2);
  assert.equal(reads, 1);
  await act(async () => render(false));
  await act(async () => render(true));
  assert.equal(reads, 1, 'remount must not reread or re-encode saved bytes');
});

test('saved SVG previews sanitize content before image state and cache identical conversions', async () => {
  const { mediaImageSource } = await import('../media-image-source.js');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="alert(1)"><script>alert(1)</script><rect width="120" height="60" fill="red"/></svg>';
  const result = { ok: true as const, mimeType: 'image/svg+xml', base64: Buffer.from(svg).toString('base64') };
  const [first, second] = await Promise.all([mediaImageSource(result), mediaImageSource(result)]);
  assert.equal(first, second);
  assert.ok(first);
  assert.doesNotMatch(decodeURIComponent(first), /script|onload/);
  assert.match(decodeURIComponent(first), /rect/);
  await assert.rejects(mediaImageSource({ ...result, base64: Buffer.from('not SVG').toString('base64') }));
});
