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
import { it } from 'node:test';
import { applyCompanionInteractionEvent } from '../../renderer/features/workbar/testing.js';

it('keeps companion forms pending until the Host acknowledgement arrives', () => {
  let queues = applyCompanionInteractionEvent({}, 'fork-1', {
    type: 'form_request',
    id: 'form-event',
    turnId: 'turn-1',
    ts: 1,
    requestId: 'form-1',
    toolUseId: 'tool-1',
    message: 'Configure deployment',
    requester: { name: 'deploy' },
    fields: [{ kind: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
  });
  assert.equal(queues['fork-1']?.[0]?.requestId, 'form-1');

  queues = applyCompanionInteractionEvent(queues, 'fork-1', {
    type: 'form_answer_ack',
    id: 'form-ack',
    turnId: 'turn-1',
    ts: 2,
    requestId: 'form-1',
    toolUseId: 'tool-1',
  });
  assert.deepEqual(queues['fork-1'], []);
});
