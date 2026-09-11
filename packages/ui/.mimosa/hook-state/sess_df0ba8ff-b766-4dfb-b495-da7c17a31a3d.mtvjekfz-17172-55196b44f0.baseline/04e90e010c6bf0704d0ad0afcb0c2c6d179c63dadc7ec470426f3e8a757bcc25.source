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
import type { FormRequestEvent } from '@maka/core/events';
import { FormInteractionPrompt } from '../form-interaction-prompt.js';
import { LocaleProvider } from '../locale-context.js';

const request: FormRequestEvent = {
  type: 'form_request',
  id: 'event-1',
  turnId: 'turn-1',
  ts: 1,
  requestId: 'form-1',
  toolUseId: 'tool-1',
  message: 'Configure release',
  requester: { name: 'release' },
  fields: [
    { kind: 'string', name: 'version', label: 'Version', required: true },
    { kind: 'integer', name: 'replicas', label: 'Replicas', required: true, minimum: 997, maximum: 997 },
    { kind: 'string', name: 'when', label: 'When', required: true, format: 'date-time' },
    { kind: 'string', name: 'notes', label: 'Notes', required: false },
  ],
};

test('same-request recovery preserves drafts and renders accessible constraints', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const render = async (next: FormRequestEvent) => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <FormInteractionPrompt request={next} onRespond={() => undefined} />
      </LocaleProvider>,
    ));
  };

  try {
    await render(request);
    const includeNotes = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(includeNotes);
    assert.equal(includeNotes.checked, false);
    await act(() => {
      includeNotes.checked = true;
      includeNotes.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    await render({
      ...request,
      fields: request.fields.map((field) => ({
        ...field,
        ...(field.kind === 'single_select' || field.kind === 'multi_select'
          ? { options: field.options.map((option) => ({ ...option })) }
          : {}),
      })),
    });

    assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
    assert.match(container.textContent ?? '', /997/);
    assert.match(container.textContent ?? '', /date-time/);
    for (const field of container.querySelectorAll<HTMLElement>('[aria-describedby]')) {
      const describedBy = field.getAttribute('aria-describedby');
      if (describedBy) assert.ok(document.getElementById(describedBy));
    }

    await render({ ...request, requestId: 'form-2' });
    assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, false);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
