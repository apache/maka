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
import { describe, it } from 'node:test';

import {
  normalizeBranchFromTurnInput,
  normalizeRegenerateTurnInput,
  normalizeReviseBeforeTurnInput,
  normalizeRuntimeHostBranchFromTurnInput,
  normalizeRuntimeHostReviseBeforeTurnInput,
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
      normalizeBranchFromTurnInput({
        sourceTurnId: 'turn-3',
        name: '  Branch name  ',
        sideConversation: true,
        ignored: 1,
      }),
      { sourceTurnId: 'turn-3', name: 'Branch name', sideConversation: true },
    );
    assert.deepEqual(
      normalizeRuntimeHostBranchFromTurnInput({
        sourceTurnId: 'turn-3',
        name: '  Branch name  ',
        sideConversation: true,
        copyId: 'branch-copy-1',
        ignored: 1,
      }),
      {
        sourceTurnId: 'turn-3',
        name: 'Branch name',
        sideConversation: true,
        copyId: 'branch-copy-1',
      },
    );
    assert.deepEqual(
      normalizeRuntimeHostReviseBeforeTurnInput({
        sourceTurnId: 'turn-4',
        copyId: 'revision-copy-1',
        ignored: true,
      }),
      {
        sourceTurnId: 'turn-4',
        copyId: 'revision-copy-1',
      },
    );

    const invalidActions: Array<() => unknown> = [
      () => normalizeRegenerateTurnInput({ sourceTurnId: 'turn-1', turnId: 1 }),
      () => normalizeBranchFromTurnInput({ sourceTurnId: 'turn-1', name: 1 }),
      () => normalizeBranchFromTurnInput({ sourceTurnId: 'turn-1', sideConversation: 'yes' }),
      () => normalizeBranchFromTurnInput({ sourceTurnId: 'x'.repeat(129) }),
      () => normalizeReviseBeforeTurnInput({ sourceTurnId: 1 }),
      () => normalizeRuntimeHostBranchFromTurnInput({ sourceTurnId: 'turn-1' }),
      () => normalizeRuntimeHostReviseBeforeTurnInput({ sourceTurnId: 'turn-1', copyId: '' }),
    ];
    for (const action of invalidActions) assert.throws(action, /Invalid/);
  });

  it('strips untrusted send fields while preserving supported payloads', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        turnId: 'turn-1',
        text: 'review @packages/ui/src/chat turn.tsx',
        displayText: 'review @packages/ui/src/chat turn.tsx',
        skillIds: ['weekly-report', 'project:maka:writer'],
        attachmentItems: [{ approvalId: 'a', name: 'n' }],
        turnOrchestration: { mode: 'swarm', source: 'slash_command', ignored: true },
        quotes: [
          { text: 'the excerpt', label: '  Assistant  ', sourceTurnId: 'turn-9', extra: true },
        ],
        workspaceFileReferences: [
          {
            value: '@packages/ui/src/chat turn.tsx',
            start: 7,
            label: 'package.json',
            extra: true,
          },
        ],
        extra: true,
      }),
      {
        type: 'send',
        turnId: 'turn-1',
        text: 'review @packages/ui/src/chat turn.tsx',
        displayText: 'review @packages/ui/src/chat turn.tsx',
        skillIds: ['weekly-report', 'project:maka:writer'],
        attachmentItems: [{ approvalId: 'a', name: 'n' }],
        turnOrchestration: { mode: 'swarm', source: 'slash_command' },
        quotes: [{ text: 'the excerpt', label: 'Assistant', sourceTurnId: 'turn-9' }],
        workspaceFileReferences: [
          {
            value: '@packages/ui/src/chat turn.tsx',
            start: 7,
          },
        ],
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
      { type: 'send', text: 'hello', workspaceFileReferences: {} },
      {
        type: 'send',
        text: 'hello',
        workspaceFileReferences: [{ value: '@a.ts', start: -1 }],
      },
      {
        type: 'send',
        text: 'hello',
        workspaceFileReferences: [{ value: '@a.ts' }],
      },
      {
        type: 'send',
        text: 'hello',
        workspaceFileReferences: [{ value: '@../secret', start: 0 }],
      },
    ];
    for (const command of invalidCommands) {
      assert.throws(() => normalizeSessionSendCommand(command), /Invalid/);
    }
  });

  it('rejects empty send text without skills', () => {
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: '' }),
      /Invalid send text/,
    );
    assert.throws(
      () => normalizeSessionSendCommand({ type: 'send', text: '   ' }),
      /Invalid send text/,
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
