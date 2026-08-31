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
import type { FormRequestEvent } from '@maka/core/events';
import {
  buildInteractionFormResponse,
  createInteractionFormDrafts,
  interactionFormFieldDraftIsValid,
} from './form-interaction-prompt-state.js';

const request: FormRequestEvent = {
  id: 'event-form-1',
  type: 'form_request',
  turnId: 'turn-1',
  ts: 1,
  requestId: 'form-1',
  toolUseId: 'tool-1',
  message: 'Create the release',
  requester: { name: 'release_form', source: 'Acme MCP' },
  fields: [
    { name: 'name', label: 'Name', kind: 'string', required: true, minLength: 2 },
    { name: 'retries', label: 'Retries', kind: 'integer', required: false, minimum: 0, default: 2 },
    { name: 'notify', label: 'Notify', kind: 'boolean', required: false },
    { name: 'channel', label: 'Channel', kind: 'single_select', required: true, options: [{ value: 'stable', label: 'Stable' }] },
    { name: 'owners', label: 'Owners', kind: 'multi_select', required: false, minItems: 1, options: [{ value: 'a', label: 'A' }] },
  ],
};

test('form drafts preserve defaults and distinguish omitted optional booleans from false', () => {
  assert.deepEqual(createInteractionFormDrafts(request.fields), [
    { included: true, value: '' },
    { included: true, value: '2' },
    { included: false, value: false },
    { included: true, value: '' },
    { included: false, value: [] },
  ]);
});

test('accepted response parses numbers and omits excluded optional fields', () => {
  const drafts = createInteractionFormDrafts(request.fields).map((draft) => ({ ...draft }));
  drafts[0] = { included: true, value: 'v1' };
  drafts[3] = { included: true, value: 'stable' };
  assert.deepEqual(buildInteractionFormResponse(request, drafts), {
    requestId: 'form-1',
    action: 'accept',
    values: { name: 'v1', retries: 2, channel: 'stable' },
  });
});

test('number fields preserve and accept finite fractional values', () => {
  const numberRequest: FormRequestEvent = {
    ...request,
    requestId: 'form-number',
    fields: [
      {
        name: 'threshold',
        label: 'Threshold',
        kind: 'number',
        required: true,
        default: 1.5,
      },
    ],
  };
  const drafts = createInteractionFormDrafts(numberRequest.fields);
  assert.deepEqual(drafts, [{ included: true, value: '1.5' }]);
  assert.deepEqual(buildInteractionFormResponse(numberRequest, drafts), {
    requestId: 'form-number',
    action: 'accept',
    values: { threshold: 1.5 },
  });
});

test('explicit optional false remains an accepted value', () => {
  const drafts = createInteractionFormDrafts(request.fields).map((draft) => ({ ...draft }));
  drafts[0] = { included: true, value: 'v1' };
  drafts[2] = { included: true, value: false };
  drafts[3] = { included: true, value: 'stable' };
  const response = buildInteractionFormResponse(request, drafts);
  assert.equal(response?.action, 'accept');
  if (response?.action !== 'accept') assert.fail('expected an accepted response');
  assert.deepEqual(response.values.notify, false);
});

test('invalid integer, required value, and multi-select bounds block acceptance', () => {
  const drafts = createInteractionFormDrafts(request.fields).map((draft) => ({ ...draft }));
  drafts[0] = { included: true, value: 'v1' };
  drafts[1] = { included: true, value: '2.5' };
  drafts[3] = { included: true, value: 'stable' };
  assert.equal(interactionFormFieldDraftIsValid(request.fields[1]!, drafts[1]!), false);
  assert.equal(buildInteractionFormResponse(request, drafts), null);

  drafts[1] = { included: true, value: '2' };
  drafts[4] = { included: true, value: [] };
  assert.equal(buildInteractionFormResponse(request, drafts), null);
});

test('protocol field names remain own data properties', () => {
  const reservedNameRequest: FormRequestEvent = {
    ...request,
    fields: [{ name: '__proto__', label: 'Prototype', kind: 'string', required: true }],
  };
  const response = buildInteractionFormResponse(
    reservedNameRequest,
    [{ included: true, value: 'unchanged' }],
  );
  assert.equal(response?.action, 'accept');
  if (response?.action !== 'accept') assert.fail('expected an accepted response');
  assert.equal(Object.hasOwn(response.values, '__proto__'), true);
  assert.equal(response.values.__proto__, 'unchanged');
});
