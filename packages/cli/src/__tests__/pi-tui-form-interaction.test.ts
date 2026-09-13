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
import type { TUI } from '@earendil-works/pi-tui';
import type { FormRequestEvent } from '@maka/core/events';
import type { InteractionFormResponse } from '@maka/core/interaction';
import {
  buildTuiFormResponse,
  createTuiFormDrafts,
  FormInteractionOverlay,
} from '../pi-tui-form-interaction.js';
import { stripAnsi } from '../tui-ansi.js';

const REQUEST: FormRequestEvent = {
  type: 'form_request',
  id: 'event-form',
  ts: 1,
  turnId: 'turn-1',
  requestId: 'form-1',
  toolUseId: 'tool-1',
  message: 'Configure deployment',
  requester: { name: 'deploy', source: 'Acme MCP' },
  fields: [
    { kind: 'string', name: 'version', label: 'Version', required: true, minLength: 2 },
    { kind: 'number', name: 'ratio', label: 'Ratio', required: true, default: 1.5 },
    { kind: 'integer', name: 'replicas', label: 'Replicas', required: true, default: 3 },
    { kind: 'boolean', name: 'notify', label: 'Notify', required: false },
    {
      kind: 'single_select',
      name: 'channel',
      label: 'Channel',
      required: true,
      default: 'stable',
      options: [
        { value: 'stable', label: 'Stable' },
        { value: 'canary', label: 'Canary' },
      ],
    },
    {
      kind: 'multi_select',
      name: 'owners',
      label: 'Owners',
      required: false,
      default: ['a'],
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
  ],
};

test('TUI drafts cover every primitive and preserve optional omission', () => {
  assert.deepEqual(createTuiFormDrafts(REQUEST.fields), [
    { included: true, value: '' },
    { included: true, value: '1.5' },
    { included: true, value: '3' },
    { included: false, value: false },
    { included: true, value: 'stable' },
    { included: true, value: ['a'] },
  ]);
});

test('TUI acceptance parses numbers without inventing omitted values', () => {
  const drafts = createTuiFormDrafts(REQUEST.fields);
  drafts[0] = { included: true, value: 'v2' };
  assert.deepEqual(buildTuiFormResponse(REQUEST, drafts), {
    requestId: 'form-1',
    action: 'accept',
    values: {
      version: 'v2',
      ratio: 1.5,
      replicas: 3,
      channel: 'stable',
      owners: ['a'],
    },
  });
  drafts[2] = { included: true, value: '3.5' };
  assert.equal(buildTuiFormResponse(REQUEST, drafts), null);
});

test('protocol field names remain own data properties', () => {
  const request = {
    ...REQUEST,
    fields: [{ kind: 'string', name: '__proto__', label: 'Prototype', required: true }],
  } satisfies FormRequestEvent;
  const response = buildTuiFormResponse(request, [{ included: true, value: 'data' }]);
  assert.equal(response?.action, 'accept');
  if (response?.action !== 'accept') assert.fail('expected an accepted response');
  assert.equal(Object.hasOwn(response.values, '__proto__'), true);
  assert.equal(response.values.__proto__, 'data');
});

test('overlay retains invalid drafts, then submits the corrected value', () => {
  const responses: InteractionFormResponse[] = [];
  const request = { ...REQUEST, fields: [REQUEST.fields[0]!] };
  const overlay = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request,
    onRespond: (response) => responses.push(response),
  });

  overlay.handleInput('s');
  assert.equal(responses.length, 0);
  assert.match(rendered(overlay), /Value does not meet this field's constraints/u);

  overlay.handleInput('\r');
  overlay.handleInput('v');
  overlay.handleInput('2');
  overlay.handleInput('\r');
  overlay.handleInput('s');
  assert.deepEqual(responses, [
    { requestId: 'form-1', action: 'accept', values: { version: 'v2' } },
  ]);
});

test('overlay restores a same-request draft and explains active constraints', () => {
  const request = {
    ...REQUEST,
    fields: [
      {
        kind: 'string',
        name: 'version',
        label: 'Version',
        required: true,
        minLength: 2,
        maxLength: 12,
        format: 'date-time',
      },
    ],
  } satisfies FormRequestEvent;
  const first = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request,
    onRespond: () => undefined,
  });
  assert.match(rendered(first), /2–12 characters · Format: date-time/u);
  first.handleInput('\r');
  first.handleInput('2');
  first.handleInput('\r');

  const restored = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request: { ...request, fields: request.fields.map((field) => ({ ...field })) },
    initialDrafts: first.snapshotDrafts(),
    onRespond: () => undefined,
  });
  assert.match(rendered(restored), /Version \(required\): 2/u);
});

test('overlay distinguishes optional false, decline, and cancel', () => {
  const request = { ...REQUEST, fields: [REQUEST.fields[3]!] };
  const accepted: InteractionFormResponse[] = [];
  const overlay = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request,
    onRespond: (response) => accepted.push(response),
  });
  assert.match(rendered(overlay), /omitted/u);
  overlay.handleInput(' ');
  overlay.handleInput('s');
  assert.deepEqual(accepted, [
    { requestId: 'form-1', action: 'accept', values: { notify: false } },
  ]);

  const declined: InteractionFormResponse[] = [];
  new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request,
    onRespond: (response) => declined.push(response),
  }).handleInput('d');
  assert.deepEqual(declined, [{ requestId: 'form-1', action: 'decline' }]);

  const cancelled: InteractionFormResponse[] = [];
  new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request,
    onRespond: (response) => cancelled.push(response),
  }).handleInput('\u001b');
  assert.deepEqual(cancelled, [{ requestId: 'form-1', action: 'cancel' }]);
});

test('overlay renders provenance and neutralizes terminal control text', () => {
  const overlay = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request: {
      ...REQUEST,
      message: '\u001b[31mDeploy\nnow',
      requester: { name: '\u202edeploy', source: '\u001b]0;owned\u0007MCP' },
      fields: [
        {
          kind: 'string',
          name: 'name',
          label: '\u001b[2JName',
          required: false,
          default: '\u001b[31mvalue',
        },
      ],
    },
    onRespond: () => undefined,
  });
  const output = rendered(overlay);
  assert.match(output, /Deploy now/u);
  assert.match(output, /Requested by deploy · MCP/u);
  assert.match(output, /Do not enter passwords, API keys, access tokens, or payment details/u);
  assert.doesNotMatch(output, /\u001b\[31m|\u001b\]0/u);
});

test('overlay keeps bounded field and option windows around the active row', () => {
  const fields = Array.from({ length: 12 }, (_, index) => ({
    kind: 'boolean' as const,
    name: `field-${index}`,
    label: `Field ${index}`,
    required: true,
  }));
  const overlay = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request: { ...REQUEST, fields },
    onRespond: () => undefined,
  });
  for (let index = 0; index < 10; index += 1) overlay.handleInput('\u001b[B');
  const fieldWindow = rendered(overlay);
  assert.match(fieldWindow, /Field 10/u);
  assert.match(fieldWindow, /… ↑/u);
  assert.doesNotMatch(fieldWindow, /Field 0 /u);

  const options = Array.from({ length: 14 }, (_, index) => ({
    value: `option-${index}`,
    label: `Option ${index}`,
  }));
  const optionOverlay = new FormInteractionOverlay(fakeTui(), {
    locale: 'en',
    request: {
      ...REQUEST,
      fields: [
        {
          kind: 'single_select',
          name: 'choice',
          label: 'Choice',
          required: true,
          options,
        },
      ],
    },
    onRespond: () => undefined,
  });
  optionOverlay.handleInput('\r');
  for (let index = 0; index < 11; index += 1) optionOverlay.handleInput('\u001b[B');
  const optionWindow = rendered(optionOverlay);
  assert.match(optionWindow, /Option 11/u);
  assert.match(optionWindow, /… ↑/u);
  assert.doesNotMatch(optionWindow, /Option 0/u);
});

function fakeTui(): TUI {
  return { requestRender: () => undefined } as unknown as TUI;
}

function rendered(overlay: FormInteractionOverlay): string {
  return overlay.render(100).map(stripAnsi).join('\n');
}
