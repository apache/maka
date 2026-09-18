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
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { QuoteCommentPanel } from '../quote-comment-panel.js';
import { LocaleProvider } from '../locale-context.js';
import { QUOTE_COMMENT_MAX_LENGTH, type QuoteRef } from '@maka/core/events';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const mountedRoots: Root[] = [];

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
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container as unknown as Element);
  mountedRoots.push(root);
  return { container, root };
}

const QUOTE: QuoteRef = {
  text: 'the deploy failed at step three',
  label: 'Assistant',
  sourceTurnId: 'turn-9',
};

interface PanelProps {
  comment?: string;
  onSubmit?: (comment: string) => void;
  onSkip?: () => void;
}

async function renderPanel(props: PanelProps = {}) {
  const submitted: string[] = [];
  let skipped = 0;
  const { container, root } = domRoot();
  await act(async () => {
    root.render(
      <LocaleProvider locale="en">
        <QuoteCommentPanel
          quote={QUOTE}
          comment={props.comment}
          title="Annotate this quote"
          submitLabel="Quote"
          skipLabel="Quote as-is"
          onSubmit={(comment) => {
            submitted.push(comment);
            props.onSubmit?.(comment);
          }}
          onSkip={() => {
            skipped += 1;
            props.onSkip?.();
          }}
        />
      </LocaleProvider>,
    );
  });
  return {
    container,
    submitted,
    skipped: () => skipped,
    textarea: () => container.querySelector('textarea'),
    button: (label: string) =>
      Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label,
      ),
  };
}

/** Reads one React handler off a controlled node, the way this repo's other
 *  controlled-input suites drive a field without a real browser. */
function reactHandler<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((candidate) =>
    candidate.startsWith('__reactProps$'),
  );
  assert.ok(propsKey, 'the note field is a React-controlled node');
  const props = (element as unknown as Record<string, unknown>)[propsKey] as Record<
    string,
    unknown
  >;
  const handler = props[name];
  assert.equal(typeof handler, 'function', `the note field exposes ${name}`);
  return handler as T;
}

async function type(container: Element, value: string) {
  const textarea = container.querySelector('textarea');
  assert.ok(textarea, 'the panel renders its note field');
  textarea.value = value;
  await act(async () => {
    reactHandler<(event: { target: HTMLTextAreaElement }) => void>(textarea, 'onChange')({
      target: textarea as HTMLTextAreaElement,
    });
    await Promise.resolve();
  });
}

async function pressSubmitShortcut(container: Element) {
  const textarea = container.querySelector('textarea');
  assert.ok(textarea);
  await act(async () => {
    reactHandler<
      (event: { key: string; metaKey?: boolean; preventDefault(): void }) => void
    >(textarea, 'onKeyDown')({ key: 'Enter', metaKey: true, preventDefault() {} });
    await Promise.resolve();
  });
}

test('the panel shows the excerpt it annotates and writes the note back', async () => {
  const view = await renderPanel();
  assert.match(view.container.textContent ?? '', /the deploy failed at step three/);
  assert.match(view.container.textContent ?? '', /Assistant/);

  await type(view.container, '  is this the retry path?  ');
  view.button('Quote')?.click();
  await act(async () => {});

  assert.deepEqual(view.submitted, ['is this the retry path?']);
  assert.equal(view.skipped(), 0);
});

test('skipping stages the quote with no note', async () => {
  const view = await renderPanel();
  await type(view.container, 'a note that will be dropped');
  view.button('Quote as-is')?.click();
  await act(async () => {});

  assert.deepEqual(view.submitted, []);
  assert.equal(view.skipped(), 1);
});

test('the note is capped at the length the IPC boundary admits', async () => {
  const view = await renderPanel();
  await type(view.container, 'y'.repeat(QUOTE_COMMENT_MAX_LENGTH + 25));
  view.button('Quote')?.click();
  await act(async () => {});

  assert.equal(view.submitted[0]?.length, QUOTE_COMMENT_MAX_LENGTH);
});

test('an empty note submits as no annotation at all', async () => {
  const view = await renderPanel({ comment: 'already written' });
  await type(view.container, '   ');
  view.button('Quote')?.click();
  await act(async () => {});

  assert.deepEqual(view.submitted, ['']);
});

test('an existing note is editable in place', async () => {
  const view = await renderPanel({ comment: 'first draft' });
  assert.equal(view.textarea()?.value, 'first draft');
});

test('the submit shortcut does not need the button', async () => {
  const view = await renderPanel();
  await type(view.container, 'noted');
  await pressSubmitShortcut(view.container);

  assert.deepEqual(view.submitted, ['noted']);
});
