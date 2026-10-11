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

/**
 * Submitting the New project dialog must be the dialog's business, never the
 * browser's. The picker lives inside the composer's `<form>`, so a submit that
 * escaped this component would navigate the window. An empty name is a valid
 * submit ("use the folder name"), not a reason to swallow the event.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
import { NewProjectDialog } from '../new-project-dialog.js';

function installDomStubs(window: ReturnType<typeof parseHTML>['window']): void {
  Object.assign(globalThis, {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
  });
  window.getComputedStyle = () =>
    ({
      direction: 'ltr',
      writingMode: 'horizontal-tb',
      getPropertyValue: () => '',
    }) as unknown as CSSStyleDeclaration;
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
  // Astryx's Dialog is a controlled native `<dialog>`, and linkedom ships
  // neither it nor `CSS`. The least interesting truths, again.
  const css = { escape: (value: string) => value, supports: () => false };
  (window as unknown as Record<string, unknown>).CSS = css;
  (globalThis as unknown as Record<string, unknown>).CSS = css;
  const dialogPrototype = (window as unknown as { HTMLDialogElement?: { prototype: object } })
    .HTMLDialogElement?.prototype as Record<string, unknown> | undefined;
  const elementPrototype = (window as unknown as { HTMLElement: { prototype: object } })
    .HTMLElement.prototype as Record<string, unknown>;
  for (const target of [dialogPrototype, elementPrototype]) {
    if (!target) continue;
    target.showModal ??= function showModal(this: { open: boolean }) {
      this.open = true;
    };
    target.close ??= function close(this: { open: boolean }) {
      this.open = false;
    };
    target.select ??= () => undefined;
  }
  const globalWindow = window as unknown as Record<string, unknown>;
  globalWindow.scrollTo ??= () => undefined;
}

async function mountDialog() {
  const original = { document: globalThis.document, window: globalThis.window };
  const { document, window } = parseHTML('<div id="root"></div>');
  installDomStubs(window);
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  const submitted: Array<string | undefined> = [];
  let openChanges = 0;
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <LocaleProvider locale="en">
        <NewProjectDialog
          onOpenChange={() => {
            openChanges += 1;
          }}
          onSubmit={(name) => {
            submitted.push(name);
          }}
        />
      </LocaleProvider>,
    ),
  );

  return {
    document,
    submitted,
    openChanges: () => openChanges,
    type: async (value: string) => {
      const input = document.querySelector('input');
      assert.ok(input, 'no name field');
      await act(() => {
        input.value = value;
        // linkedom does not run React's native input listener; call it the same
        // way `project-add-restore` types into this field.
        const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
        assert.ok(propsKey, 'no react props on the name field');
        const props = (input as unknown as Record<string, unknown>)[propsKey] as {
          onChange: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
        };
        props.onChange({ target: input, defaultPrevented: false });
      });
    },
    submit: () => {
      const form = document.querySelector('#maka-new-project-form');
      assert.ok(form, 'no form');
      const event = new window.Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      return event;
    },
    dispose: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
  };
}

test('a submit belongs to the dialog and never reaches the browser', async () => {
  const dialog = await mountDialog();
  try {
    let event!: Event;
    await act(() => {
      event = dialog.submit();
    });

    assert.equal(event.defaultPrevented, true);
    // The dialog asked to close, which is what a handled submit does here.
    assert.equal(dialog.openChanges(), 1);
  } finally {
    await dialog.dispose();
  }
});

test('an empty name still opens the folder picker', async () => {
  const dialog = await mountDialog();
  try {
    const button = dialog.document.querySelector<HTMLButtonElement>(
      'button[type="submit"][form="maka-new-project-form"]',
    );
    assert.ok(button, 'no choose-folder button');
    assert.equal(button.disabled, false);

    let event!: Event;
    await act(() => {
      event = dialog.submit();
    });

    assert.equal(event.defaultPrevented, true);
    assert.equal(dialog.openChanges(), 1);
    assert.deepEqual(dialog.submitted, [undefined]);
  } finally {
    await dialog.dispose();
  }
});

test('a typed name is trimmed and passed through', async () => {
  const dialog = await mountDialog();
  try {
    await dialog.type('  Lab notes  ');
    await act(() => {
      dialog.submit();
    });
    assert.deepEqual(dialog.submitted, ['Lab notes']);
  } finally {
    await dialog.dispose();
  }
});

test('a whitespace-only name is not a custom name', async () => {
  const dialog = await mountDialog();
  try {
    await dialog.type('   ');
    await act(() => {
      dialog.submit();
    });
    assert.deepEqual(dialog.submitted, [undefined]);
  } finally {
    await dialog.dispose();
  }
});
