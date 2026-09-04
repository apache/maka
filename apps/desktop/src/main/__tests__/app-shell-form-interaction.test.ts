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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { InteractionQueues } from '@maka/ui';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { createActionsDeps } from './app-shell-chat-actions-fixture.js';

function pendingForm(): InteractionQueues {
  return {
    'session-1': [{
      type: 'form_request',
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'form-1',
      toolUseId: 'tool-1',
      message: 'Configure deployment',
      requester: { name: 'deploy' },
      fields: [{ kind: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
    }],
  };
}

describe('AppShell form interaction response', () => {
  it('retires the local prompt only after the platform accepts the answer', async () => {
    const deps = createActionsDeps();
    deps.activeIdRef.current = 'session-1';
    let interactions = pendingForm();
    let submitted: unknown;
    const actions = createAppShellChatActions({
      ...deps,
      respondToUserForm: async (sessionId, response) => {
        submitted = { sessionId, response };
      },
      setInteractionBySession: (update) => {
        interactions = update(interactions);
      },
    });

    const response = { requestId: 'form-1', action: 'accept' as const, values: { confirm: true } };
    await actions.respondToUserForm(response);

    assert.deepEqual(submitted, { sessionId: 'session-1', response });
    assert.deepEqual(interactions['session-1'], []);
  });

  it('keeps the prompt answerable when the platform rejects the answer', async () => {
    const deps = createActionsDeps();
    deps.activeIdRef.current = 'session-1';
    let interactions = pendingForm();
    let errors = 0;
    const actions = createAppShellChatActions({
      ...deps,
      respondToUserForm: async () => {
        throw new Error('Host unavailable');
      },
      setInteractionBySession: (update) => {
        interactions = update(interactions);
      },
      toastApi: { error: () => { errors += 1; }, info: () => undefined },
    });

    await actions.respondToUserForm({ requestId: 'form-1', action: 'cancel' });

    assert.equal(interactions['session-1']?.[0]?.requestId, 'form-1');
    assert.equal(errors, 1);
  });
});
