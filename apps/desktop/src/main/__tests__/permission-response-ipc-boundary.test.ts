import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeBranchFromTurnInput,
  normalizeRegenerateTurnInput,
  normalizeReviseBeforeTurnInput,
  normalizeSandboxBoundaryResponse,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
  normalizeUserQuestionResponse,
} from '../permission-response-guard.js';

describe('permission response IPC boundary', () => {
  it('accepts only bounded permission and question responses', () => {
    assert.deepEqual(
      normalizeSandboxBoundaryResponse({
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
      }),
      { requestId: 'permission-1', decision: 'allow' },
    );
    assert.deepEqual(
      normalizeUserQuestionResponse({
        requestId: 'question-1',
        answers: ['Option A', null],
        extra: true,
      }),
      { requestId: 'question-1', answers: ['Option A', null] },
    );

    const invalidPermissionResponses = [
      null,
      { requestId: '', decision: 'allow' },
      { requestId: 'x'.repeat(129), decision: 'deny' },
      { requestId: 'permission-1', decision: 'approve' },
    ];
    for (const response of invalidPermissionResponses) {
      assert.throws(() => normalizeSandboxBoundaryResponse(response), /sandbox boundary response/);
    }

    const invalidQuestionResponses = [
      { requestId: '', answers: ['A'] },
      { requestId: 'q', answers: [] },
      { requestId: 'q', answers: ['A', 'B', 'C', 'D'] },
      { requestId: 'q', answers: [1] },
    ];
    for (const response of invalidQuestionResponses) {
      assert.throws(() => normalizeUserQuestionResponse(response), /user question response/);
    }
  });

  it('normalizes turn actions and rejects malformed identifiers', () => {
    assert.deepEqual(normalizeRegenerateTurnInput({ sourceTurnId: 'turn-2', turnId: 'turn-3' }), {
      sourceTurnId: 'turn-2',
      turnId: 'turn-3',
    });
    assert.deepEqual(
      normalizeBranchFromTurnInput({ sourceTurnId: 'turn-3', name: '  Branch name  ', ignored: 1 }),
      { sourceTurnId: 'turn-3', name: 'Branch name' },
    );
    assert.deepEqual(normalizeReviseBeforeTurnInput({ sourceTurnId: 'turn-4', ignored: true }), {
      sourceTurnId: 'turn-4',
    });

    const invalidActions: Array<() => unknown> = [
      () => normalizeRegenerateTurnInput({ sourceTurnId: 'turn-1', turnId: 1 }),
      () => normalizeBranchFromTurnInput({ sourceTurnId: 'turn-1', name: 1 }),
      () => normalizeBranchFromTurnInput({ sourceTurnId: 'x'.repeat(129) }),
      () => normalizeReviseBeforeTurnInput({ sourceTurnId: 1 }),
    ];
    for (const action of invalidActions) assert.throws(action, /Invalid/);
  });

  it('strips untrusted send fields while preserving supported payloads', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        turnId: 'turn-1',
        text: 'inspect the repository',
        displayText: 'Inspect',
        skillIds: ['weekly-report', 'project:maka:writer'],
        attachmentItems: [{ approvalId: 'a', name: 'n' }],
        turnOrchestration: { mode: 'swarm', source: 'slash_command', ignored: true },
        quotes: [
          { text: 'the excerpt', label: '  Assistant  ', sourceTurnId: 'turn-9', extra: true },
        ],
        extra: true,
      }),
      {
        type: 'send',
        turnId: 'turn-1',
        text: 'inspect the repository',
        displayText: 'Inspect',
        skillIds: ['weekly-report', 'project:maka:writer'],
        attachmentItems: [{ approvalId: 'a', name: 'n' }],
        turnOrchestration: { mode: 'swarm', source: 'slash_command' },
        quotes: [{ text: 'the excerpt', label: 'Assistant', sourceTurnId: 'turn-9' }],
      },
    );
    assert.equal(normalizeSessionSendCommand({ type: 'stop' }), undefined);
    assert.deepEqual(normalizeSessionSendCommand({ type: 'send', text: '', skillIds: ['writer'] }), {
      type: 'send',
      text: '',
      skillIds: ['writer'],
    });
  });

  it('rejects malformed or oversized send payloads', () => {
    const invalidCommands = [
      null,
      { type: 'send', text: '' },
      { type: 'send', text: 'x'.repeat(128_001) },
      { type: 'send', text: 'hello', turnId: 1 },
      { type: 'send', text: 'hello', skillIds: ['/bad'] },
      { type: 'send', text: 'hello', turnOrchestration: { mode: 'swarm', source: 'prompt' } },
      { type: 'send', text: 'hello', quotes: {} },
      { type: 'send', text: 'hello', quotes: Array(17).fill({ text: 'x' }) },
      { type: 'send', text: 'hello', quotes: [{ text: '' }] },
      { type: 'send', text: 'hello', quotes: [{ text: 'x', sourceTurnId: 1 }] },
    ];
    for (const command of invalidCommands) {
      assert.throws(() => normalizeSessionSendCommand(command), /Invalid/);
    }
  });

  it('allows a valid voice-only send and validates the operation id', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        text: '',
        voiceOperationId: '123e4567-e89b-12d3-a456-426614174000',
      }),
      {
        type: 'send',
        text: '',
        voiceOperationId: '123e4567-e89b-12d3-a456-426614174000',
      },
    );
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: '', voiceOperationId: 'not-a-uuid' }),
      /voice operation id/,
    );
  });

  it('accepts only the supported stop source', () => {
    assert.deepEqual(normalizeStopSessionInput(undefined), {});
    assert.deepEqual(normalizeStopSessionInput({ source: 'stop_button', extra: true }), {
      source: 'stop_button',
    });
    assert.throws(() => normalizeStopSessionInput(null), /stop session input/);
    assert.throws(() => normalizeStopSessionInput({ source: 'toolbar' }), /stop session source/);
  });
});
