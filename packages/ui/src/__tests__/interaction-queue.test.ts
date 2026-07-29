import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
} from '@maka/core';
import {
  activeInteractionFor,
  clearInteractions,
  dequeueInteractionByRequestId,
  dequeueInteractionByToolUseId,
  enqueueInteraction,
  reconcileSandboxBoundaryInteractions,
  type InteractionQueues,
} from '../interaction-queue.js';

function boundary(requestId: string): SandboxBoundaryRequestEvent {
  return {
    type: 'sandbox_boundary_request',
    id: `evt_${requestId}`,
    turnId: 'turn_1',
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    justification: 'Read an external file.',
    expansion: {
      filesystem: {
        entries: [{ path: '/outside/file', access: 'read', scope: 'exact' }],
      },
    },
  };
}

function question(requestId: string): UserQuestionRequestEvent {
  return {
    type: 'user_question_request',
    id: `evt_${requestId}`,
    ts: 0,
    requestId,
    toolUseId: `call_${requestId}`,
    turnId: 'turn_1',
    questions: [{ question: 'Choose', options: [{ label: 'A' }] }],
  };
}

describe('composer interaction queue', () => {
  test('boundary and question requests share one FIFO per session', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', boundary('boundary'));
    queues = enqueueInteraction(queues, 's', question('question'));

    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'boundary');
    queues = dequeueInteractionByRequestId(queues, 's', 'boundary');
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'question');
  });

  test('deduplicates replays and isolates sessions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's1', question('a'));
    queues = enqueueInteraction(queues, 's1', question('a'));
    queues = enqueueInteraction(queues, 's2', boundary('b'));

    assert.equal(queues.s1.length, 1);
    assert.equal(activeInteractionFor(queues, 's2')?.requestId, 'b');
  });

  test('tool completion and terminal events drain stale interactions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', boundary('a'));
    queues = enqueueInteraction(queues, 's', question('b'));

    queues = dequeueInteractionByToolUseId(queues, 's', 'call_a');
    assert.equal(activeInteractionFor(queues, 's')?.requestId, 'b');
    assert.equal(dequeueInteractionByToolUseId(queues, 's', 'missing'), queues);

    queues = clearInteractions(queues, 's');
    assert.equal(activeInteractionFor(queues, 's'), undefined);
  });

  test('rehydration replaces only boundary prompts and preserves user questions', () => {
    let queues: InteractionQueues = {};
    queues = enqueueInteraction(queues, 's', boundary('stale'));
    queues = enqueueInteraction(queues, 's', question('question'));
    queues = enqueueInteraction(queues, 's', boundary('live'));

    const reconciled = reconcileSandboxBoundaryInteractions(queues, 's', [
      boundary('live'),
      boundary('new'),
    ]);

    assert.deepEqual(
      reconciled.s.map((interaction) => interaction.requestId),
      ['question', 'live', 'new'],
    );
  });
});
