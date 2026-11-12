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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { InteractionFormResult } from '@maka/core/interaction';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import type { InteractionRecord } from '@maka/storage/interaction-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { readGoalFormEvidence, unreadGoalFormToolResponses } from '../server/goal-form-evidence.js';

const IDENTITY = { sessionId: 'form-session', turnId: 'form-turn', runId: 'form-run' };

test('Goal form evidence reads canonical answers independently of the eventual tool output', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-form-evidence-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  t.after(async () => {
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  });
  const read = (requestId: string) => stores.interactionStore.readInteraction(requestId);
  const establish = async (
    requestId: string,
    answer?: InteractionFormResult,
    selected = { value: 'staging', label: 'Staging' },
  ) => {
    const established = await stores.interactionStore.establishRequest({
      ...IDENTITY,
      requestId,
      createdAt: 1,
      request: {
        kind: 'form',
        toolUseId: `tool-${requestId}`,
        message: 'Choose the deployment target',
        requester: { name: 'deployment', source: 'private-provider-metadata' },
        fields: [
          {
            kind: 'single_select',
            name: 'target',
            label: 'Deployment target',
            required: true,
            default: 'production',
            description: 'private-field-description',
            options: [
              {
                value: 'production',
                label: 'Production',
                description: 'private-option-description',
              },
              { ...selected, description: 'private-selected-option-description' },
            ],
          },
        ],
      },
    });
    assert.equal(established.status, 'stable');
    if (answer) {
      const committed = await stores.interactionStore.commitOutcome(requestId, {
        kind: 'form_answer',
        ...answer,
        committedAt: 2,
      });
      assert.equal(committed.status, 'stable');
    }
    const record = await read(requestId);
    assert.ok(record);
    return record;
  };

  await t.test('accepted values survive a final tool result that does not echo them', async () => {
    await establish('accepted', { action: 'accept', values: { target: 'staging' } });
    const evidence = await readGoalFormEvidence(IDENTITY.sessionId, [ack('accepted')], read);
    assert.deepEqual(evidence, [
      {
        turnId: IDENTITY.turnId,
        toolUseId: 'tool-accepted',
        requestId: 'accepted',
        action: 'accept',
        message: 'Choose the deployment target',
        fields: [{ name: 'target', label: 'Deployment target' }],
        values: { target: 'staging' },
        selectedOptions: { target: [{ value: 'staging', label: 'Staging' }] },
      },
    ]);
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /private-|production/);
  });

  await t.test(
    'selected labels preserve the meaning of opaque values without other options',
    async () => {
      for (const label of ['Allow', 'Reject']) {
        await establish(
          `opaque-${label}`,
          { action: 'accept', values: { target: 'option-a' } },
          { value: 'option-a', label },
        );
        const evidence = await readGoalFormEvidence(
          IDENTITY.sessionId,
          [ack(`opaque-${label}`)],
          read,
        );
        assert.deepEqual(evidence[0]?.values, { target: 'option-a' });
        assert.deepEqual(evidence[0]?.selectedOptions, {
          target: [{ value: 'option-a', label }],
        });
        assert.doesNotMatch(JSON.stringify(evidence), /production|private-/);
      }
    },
  );

  await t.test('multi-select evidence contains only labels for accepted values', async () => {
    const requestId = 'multi-select';
    await stores.interactionStore.establishRequest({
      ...IDENTITY,
      requestId,
      createdAt: 1,
      request: {
        kind: 'form',
        toolUseId: `tool-${requestId}`,
        message: 'Select environments',
        requester: { name: 'deployment' },
        fields: [
          {
            kind: 'multi_select',
            name: 'targets',
            label: 'Environments',
            required: true,
            default: ['option-private'],
            options: [
              { value: 'option-a', label: 'Staging' },
              { value: 'option-b', label: 'Development' },
              { value: 'option-private', label: 'Private unselected environment' },
            ],
          },
        ],
      },
    });
    await stores.interactionStore.commitOutcome(requestId, {
      kind: 'form_answer',
      action: 'accept',
      values: { targets: ['option-b', 'option-a'] },
      committedAt: 2,
    });
    const evidence = await readGoalFormEvidence(IDENTITY.sessionId, [ack(requestId)], read);
    assert.deepEqual(evidence[0]?.values, { targets: ['option-b', 'option-a'] });
    assert.deepEqual(evidence[0]?.selectedOptions, {
      targets: [
        { value: 'option-a', label: 'Staging' },
        { value: 'option-b', label: 'Development' },
      ],
    });
    assert.doesNotMatch(JSON.stringify(evidence), /Private|option-private/);
  });

  await t.test('decline and cancellation do not reuse defaults as answers', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      await establish(action, { action });
      const evidence = await readGoalFormEvidence(IDENTITY.sessionId, [ack(action)], read);
      assert.equal(evidence[0]?.action, action);
      assert.equal(evidence[0]?.values, undefined);
      assert.doesNotMatch(JSON.stringify(evidence), /production|staging/);
    }
  });

  await t.test('bounds reads to six distinct recent acknowledgements in ledger order', async () => {
    const events: RuntimeEvent[] = [];
    for (let index = 0; index < 8; index += 1) {
      const requestId = `recent-${index}`;
      await establish(requestId, { action: 'accept', values: { target: 'staging' } });
      // Event order, rather than a potentially repeated or non-monotonic clock,
      // owns chronology. Repeated replay acknowledgements consume one place.
      events.push({ ...ack(requestId), ts: 100 - index });
    }
    events.push(ack('recent-7'));
    const reads: string[] = [];
    const evidence = await readGoalFormEvidence(IDENTITY.sessionId, events, (requestId) => {
      reads.push(requestId);
      return read(requestId);
    });
    assert.deepEqual(
      reads,
      Array.from({ length: 6 }, (_, index) => `recent-${index + 2}`),
    );
    assert.deepEqual(
      evidence.map(({ requestId }) => requestId),
      reads,
    );
    assert.deepEqual(
      unreadGoalFormToolResponses(IDENTITY.sessionId, events, evidence, [
        { turnId: IDENTITY.turnId, toolUseId: 'tool-recent-0' },
        { turnId: IDENTITY.turnId, toolUseId: 'tool-recent-2' },
      ]),
      [{ turnId: IDENTITY.turnId, toolUseId: 'tool-recent-0' }],
    );
  });

  await t.test(
    'an unread credential form still guards a Tool with newer ordinary answers',
    async () => {
      const toolUseId = 'multi-form-tool';
      const events: RuntimeEvent[] = [];
      for (let index = 0; index < 8; index += 1) {
        const requestId = `multi-form-${index}`;
        await stores.interactionStore.establishRequest({
          ...IDENTITY,
          requestId,
          createdAt: index,
          request: {
            kind: 'form',
            toolUseId,
            message: 'Provide settings',
            requester: { name: 'deployment', source: 'private-provider-metadata' },
            fields: [
              {
                kind: 'string',
                name: 'value',
                label: index === 0 ? 'Password' : 'Deployment target',
                required: true,
                maxLength: 64,
              },
            ],
          },
        });
        await stores.interactionStore.commitOutcome(requestId, {
          kind: 'form_answer',
          action: 'accept',
          values: { value: index === 0 ? 'credential-value' : `ordinary-${index}` },
          committedAt: index + 1,
        });
        events.push({ ...ack(requestId), refs: { toolCallId: toolUseId } });
      }
      events.push(events[7]!);
      const reads: string[] = [];
      const answers = await readGoalFormEvidence(IDENTITY.sessionId, events, (requestId) => {
        reads.push(requestId);
        return read(requestId);
      });
      // Replayed acknowledgements remain distinct by request identity, and the
      // reader retains its existing six-authority-read contract.
      assert.equal(reads.length, 6);
      assert.deepEqual(reads, [
        'multi-form-2',
        'multi-form-3',
        'multi-form-4',
        'multi-form-5',
        'multi-form-6',
        'multi-form-7',
      ]);
      assert.doesNotMatch(JSON.stringify(answers), /credential-value|Password/);
      const references = [
        { turnId: IDENTITY.turnId, toolUseId },
        { turnId: IDENTITY.turnId, toolUseId },
      ];
      const unread = unreadGoalFormToolResponses(IDENTITY.sessionId, events, answers, references);
      assert.deepEqual(unread, [references[0]]);
      assert.doesNotMatch(JSON.stringify(unread), /credential-value|private-|requestId/);
      assert.deepEqual(
        unreadGoalFormToolResponses(IDENTITY.sessionId, events, answers, [
          { turnId: 'other-turn', toolUseId },
          { turnId: IDENTITY.turnId, toolUseId: 'other-tool' },
        ]),
        [],
      );
    },
  );

  await t.test('unread-response guards ignore foreign and partial acknowledgements', () => {
    const reference = { turnId: IDENTITY.turnId, toolUseId: 'tool-unread' };
    assert.deepEqual(
      unreadGoalFormToolResponses(
        IDENTITY.sessionId,
        [
          { ...ack('unread'), sessionId: 'other-session' },
          { ...ack('unread'), partial: true },
          { ...ack('unread'), turnId: 'other-turn' },
          { ...ack('unread'), refs: {} },
          { ...ack('unread'), actions: {} },
        ],
        [],
        [reference],
      ),
      [],
    );
    assert.deepEqual(unreadGoalFormToolResponses(IDENTITY.sessionId, [ack('unread')], [], []), []);
  });

  await t.test('foreign Session and partial acknowledgements do not read authority', async () => {
    const evidence = await readGoalFormEvidence(
      IDENTITY.sessionId,
      [
        { ...ack('accepted'), sessionId: 'other-session' },
        { ...ack('accepted'), partial: true },
      ],
      async () => assert.fail('an unrelated acknowledgement must not read its record'),
    );
    assert.deepEqual(evidence, []);
  });

  await t.test('missing and pending records are not treated as human acceptance', async () => {
    await establish('pending');
    assert.deepEqual(
      await readGoalFormEvidence(IDENTITY.sessionId, [ack('missing'), ack('pending')], read),
      [unavailable('missing'), unavailable('pending')],
    );
  });

  await t.test('request and outcome identities must both match the acknowledged Run', async () => {
    const record = await read('accepted');
    assert.ok(record?.outcome);
    for (const side of ['request', 'outcome'] as const) {
      for (const key of ['sessionId', 'turnId', 'runId', 'requestId'] as const) {
        const foreign: InteractionRecord = {
          ...record,
          [side]: { ...record[side], [key]: 'foreign' },
        };
        assert.deepEqual(
          await readGoalFormEvidence(IDENTITY.sessionId, [ack('accepted')], async () => foreign),
          [unavailable('accepted')],
          `${side}.${key} must be bound to the acknowledged interaction`,
        );
      }
    }
    assert.deepEqual(
      await readGoalFormEvidence(
        IDENTITY.sessionId,
        [{ ...ack('accepted'), refs: { toolCallId: 'other-tool' } }],
        read,
      ),
      [{ ...unavailable('accepted'), toolUseId: 'other-tool' }],
    );
  });

  await t.test('closed forms and question answers are not form acceptance', async () => {
    await establish('closed');
    await stores.interactionStore.commitOutcome('closed', {
      kind: 'closure',
      reason: 'turn_stopped',
      committedAt: 2,
    });
    await stores.interactionStore.establishRequest({
      ...IDENTITY,
      requestId: 'question',
      createdAt: 1,
      request: {
        kind: 'question',
        toolUseId: 'tool-question',
        questions: [{ question: 'Publish?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    });
    await stores.interactionStore.commitOutcome('question', {
      kind: 'question_answer',
      answers: ['No'],
      committedAt: 2,
    });
    assert.deepEqual(
      await readGoalFormEvidence(IDENTITY.sessionId, [ack('closed'), ack('question')], read),
      [unavailable('closed'), unavailable('question')],
    );
  });

  await t.test('authority read failures never fall back to acknowledgement payloads', async () => {
    await assert.rejects(
      readGoalFormEvidence(IDENTITY.sessionId, [ack('accepted')], async () => {
        throw new Error('authority unavailable');
      }),
      /authority unavailable/,
    );
  });
});

function ack(requestId: string): RuntimeEvent {
  return {
    ...IDENTITY,
    invocationId: IDENTITY.runId,
    id: `ack-${requestId}`,
    ts: 3,
    partial: false,
    role: 'system',
    author: 'user',
    actions: { formAnswerAccepted: { requestId } },
    refs: { toolCallId: `tool-${requestId}` },
  };
}

function unavailable(requestId: string) {
  return {
    turnId: IDENTITY.turnId,
    toolUseId: `tool-${requestId}`,
    requestId,
    action: 'unavailable',
    message: 'The acknowledged form response is unavailable.',
    fields: [],
  };
}
