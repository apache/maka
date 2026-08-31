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
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

test('only an attachment-capable running-turn host accepts a pasted image', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  window.getSelection = () => null;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const attached: File[][] = [];
  const image = new window.File(['image'], 'screenshot.png', { type: 'image/png' });

  function pasteImage(): Event {
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [image],
        getData: () => '',
      },
    });
    return paste;
  }

  async function render(allowAttachmentImportWhileStreaming: boolean): Promise<void> {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          streaming
          allowAttachmentImportWhileStreaming={allowAttachmentImportWhileStreaming}
          onPickAttachments={() => undefined}
          onAttachFilePaths={(files) => {
            attached.push(files);
          }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
  }

  function attachmentPickerItem(): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes('Add file or directory'),
    );
  }

  try {
    // Text-only steering hosts, such as Workbar side chat, retain the default
    // gate so a successful text submit cannot leave a staged image behind.
    await render(false);
    const form = container.querySelector('form');
    const input = container.querySelector<HTMLElement>('[role="textbox"]');
    assert.ok(input);
    assert.equal(form?.getAttribute('data-maka-file-drop-target'), null);
    assert.equal(attachmentPickerItem()?.getAttribute('aria-disabled'), 'true');
    const rejectedPaste = pasteImage();
    await act(async () => {
      input.dispatchEvent(rejectedPaste);
      await Promise.resolve();
    });
    assert.equal(rejectedPaste.defaultPrevented, true);
    assert.deepEqual(attached, []);

    // AppShell opts in because both its queued and steering follow-ups carry
    // the staged attachment into the submitted message.
    await render(true);
    assert.equal(form?.getAttribute('data-maka-file-drop-target'), 'true');
    assert.notEqual(attachmentPickerItem()?.getAttribute('aria-disabled'), 'true');
    const acceptedPaste = pasteImage();
    await act(async () => {
      input.dispatchEvent(acceptedPaste);
      await Promise.resolve();
    });
    assert.equal(acceptedPaste.defaultPrevented, true);
    assert.deepEqual(attached, [[image]]);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
