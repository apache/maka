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
import { describe, test } from 'node:test';
import type { ShellRunSnapshotResult, ShellRunUpdate } from '@maka/core/events';
import type { ShellRunToolResult } from '@maka/core/shell-run-result';
import type { StoredMessage } from '@maka/core/session';
import { materializeTurns } from '../materialize.js';
import { createTranscriptProjection } from '../transcript-projection.js';
import type { LiveTurnProjection } from '../live-turn-projection.js';

const REF = 'maka://runtime/background-tasks/pty-1';

describe('ShellRun UI projection', () => {
  test('reconciles WriteStdin into its Bash parent while retaining safe operation metadata', () => {
    const messages: StoredMessage[] = [
      toolCall('bash-1', 'turn-1', 'Bash', { command: 'read value', pty: true }, 1),
      toolResult('bash-1', 'turn-1', shellRun(1), 2),
      toolCall('write-1', 'turn-2', 'WriteStdin', {
        ref: REF,
        input: 'private-value\n',
        size: { cols: 100, rows: 30 },
      }, 3),
      toolResult('write-1', 'turn-2', shellRun(2, {
        operation: {
          kind: 'pty_control',
          failed: false,
          input: { bytes: 14, queued: true },
          resize: { cols: 100, rows: 30, applied: true, changed: true },
        },
      }), 4),
    ];

    const turns = materializeTurns(messages);
    const bash = turns[0]?.tools[0];
    const write = turns[1]?.tools[0];
    assert.equal(bash?.toolName, 'Bash');
    assert.equal(bash?.result?.kind, 'shell_run');
    if (bash?.result?.kind !== 'shell_run') assert.fail('expected ShellRun parent');
    assert.equal(bash.result.revision, 2);
    assert.equal(bash.result.operation, undefined);
    assert.equal(write?.toolName, 'WriteStdin');
    assert.deepEqual(write?.args, {
      ref: REF,
      inputPreview: { text: 'private-value\\n', bytes: 14, truncated: false },
      size: { cols: 100, rows: 30 },
    });
    assert.deepEqual(
      write?.result?.kind === 'shell_run' ? write.result.operation : undefined,
      {
        kind: 'pty_control',
        failed: false,
        input: { bytes: 14, queued: true },
        resize: { cols: 100, rows: 30, applied: true, changed: true },
      },
    );
  });

  test('keeps a durable background update ahead of a stale live turn result', () => {
    const messages: StoredMessage[] = [
      toolCall('bash-1', 'turn-1', 'Bash', { command: 'job', pty: true }, 1),
      toolResult('bash-1', 'turn-1', shellRun(1), 2),
      { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 3, text: 'next' },
    ];
    const projection = createTranscriptProjection();
    const unrelatedTurn = projection.project({ messages })[1];
    const update: ShellRunUpdate = {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-1',
      result: shellRunSnapshot(3, { status: 'completed', completedAt: 5, exitCode: 0 }),
    };
    const durable = projection.project({ messages, shellRunUpdates: [update] });
    assert.equal(durable[1], unrelatedTurn);
    assert.equal(durable[0]?.tools[0]?.status, 'completed');

    const live: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'tool:bash-1',
        contentOrder: ['tools'],
        tools: [{
          toolUseId: 'bash-1',
          toolName: 'Bash',
          status: 'running',
          args: { command: 'job', pty: true },
          result: shellRun(2),
        }],
      }],
    };
    const overlaid = projection.project({ messages, liveTurn: live, shellRunUpdates: [update] });
    assert.equal(overlaid[1], unrelatedTurn, 'the live overlay must not disturb an unrelated turn');
    const result = overlaid[0]?.tools[0]?.result;
    assert.equal(result?.kind === 'shell_run' ? result.revision : undefined, 3);
    assert.equal(result?.kind === 'shell_run' ? result.status : undefined, 'completed');
  });

  test('keeps a newer live PTY screen ahead of the persisted snapshot', () => {
    const messages: StoredMessage[] = [
      toolCall('bash-1', 'turn-1', 'Bash', { command: 'job', pty: true }, 1),
      toolResult('bash-1', 'turn-1', shellRun(1), 2),
    ];
    const liveResult = shellRun(2);
    if (liveResult.output?.mode !== 'pty') assert.fail('expected PTY output');
    liveResult.output.screen = 'still running';
    const live: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'tool:bash-1',
        contentOrder: ['tools'],
        tools: [{
          toolUseId: 'bash-1',
          toolName: 'Bash',
          status: 'running',
          args: { command: 'job', pty: true },
          result: liveResult,
          outputChunks: [{
            seq: 1,
            stream: 'stdout',
            text: 'still running',
            redacted: false,
            createdAt: 3,
          }],
        }],
      }],
    };

    const tool = createTranscriptProjection()
      .project({ messages, liveTurn: live })[0]?.tools[0];
    assert.equal(tool?.result?.kind === 'shell_run' ? tool.result.revision : undefined, 2);
    assert.equal(
      tool?.result?.kind === 'shell_run' && tool.result.output?.mode === 'pty'
        ? tool.result.output.screen
        : undefined,
      'still running',
    );
    assert.equal(tool?.outputChunks?.[0]?.text, 'still running');
  });

  test('applies a durable update that arrives before the live Bash result', () => {
    const live: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'tool:bash-1',
        contentOrder: ['tools'],
        tools: [{
          toolUseId: 'bash-1',
          toolName: 'Bash',
          status: 'running',
          args: { command: 'job', pty: true },
        }],
      }],
    };
    const update: ShellRunUpdate = {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-1',
      result: shellRunSnapshot(1),
    };

    const turns = createTranscriptProjection()
      .project({ messages: [], liveTurn: live, shellRunUpdates: [update] });
    const result = turns[0]?.tools[0]?.result;
    assert.equal(result?.kind, 'shell_run');
    assert.equal(result?.kind === 'shell_run' ? result.output?.mode : undefined, 'pty');
    assert.equal(
      result?.kind === 'shell_run' && result.output?.mode === 'pty'
        ? result.output.screen
        : undefined,
      'ready',
    );
  });

  test('marks a running ShellRun inherited from a source session as detached', () => {
    const messages: StoredMessage[] = [
      toolCall('bash-1', 'turn-1', 'Bash', { command: 'job', pty: true }, 1),
      toolResult('bash-1', 'turn-1', shellRun(1), 2),
    ];
    const turns = createTranscriptProjection().project({ messages, shellRunUpdates: [{
      sessionId: 'branch-session',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'source-session',
        ownerSessionId: 'source-session',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-1',
      result: shellRunSnapshot(2),
    }] });

    assert.equal(turns[0]?.tools[0]?.shellRunSource, 'owned');
    assert.equal(turns[0]?.tools[0]?.result?.kind === 'shell_run'
      ? turns[0]?.tools[0]?.result?.status
      : undefined, 'running');

    const unavailable = createTranscriptProjection().project({ messages, shellRunUpdates: [{
      sessionId: 'branch-session',
      ownership: { kind: 'source_unavailable', sourceSessionId: 'source-session' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-1',
      result: shellRunSnapshot(2),
    }] });
    assert.equal(unavailable[0]?.tools[0]?.shellRunSource, 'unavailable');
  });
});

function toolCall(
  id: string,
  turnId: string,
  toolName: string,
  args: unknown,
  ts: number,
): Extract<StoredMessage, { type: 'tool_call' }> {
  return { type: 'tool_call', id, turnId, ts, toolName, args };
}

function toolResult(
  toolUseId: string,
  turnId: string,
  content: ShellRunToolResult,
  ts: number,
): Extract<StoredMessage, { type: 'tool_result' }> {
  return { type: 'tool_result', id: `result-${toolUseId}`, turnId, ts, toolUseId, isError: false, content };
}

function shellRun(
  revision: number,
  patch: Partial<Extract<ShellRunToolResult, { mode: 'pty' }>> = {},
): Extract<ShellRunToolResult, { mode: 'pty' }> {
  return {
    kind: 'shell_run',
    ref: REF,
    mode: 'pty',
    status: 'running',
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty',
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
    ...patch,
  };
}

function shellRunSnapshot(
  revision: number,
  patch: Partial<Extract<ShellRunSnapshotResult, { mode: 'pty' }>> = {},
): Extract<ShellRunSnapshotResult, { mode: 'pty' }> {
  return {
    kind: 'shell_run',
    ref: REF,
    mode: 'pty',
    status: 'running',
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty',
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
    ...patch,
  };
}
