/**
 * Tests for materializer.
 *
 * Run: `bun test packages/runtime/src/__tests__/materializer.test.ts`
 */

import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type {
  UserMessage,
  AssistantMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  SystemNoteMessage,
} from '@maka/core/session';
import {
  materializeSession,
  applyAppendedMessage,
  setToolStatus,
  type ChatItem,
} from '../materializer.js';

// ---------- Fixtures ----------

const ts = 1_700_000_000_000;
const turnId = 't1';

const user = (id: string, text: string): UserMessage => ({
  type: 'user',
  id,
  turnId,
  ts: ts + 1,
  text,
});

const assistant = (id: string, text: string): AssistantMessage => ({
  type: 'assistant',
  id,
  turnId,
  ts: ts + 2,
  text,
  modelId: 'claude-sonnet-4-5',
});

const toolCall = (id: string, name: string, args: unknown = {}): ToolCallMessage => ({
  type: 'tool_call',
  id,
  turnId,
  ts: ts + 3,
  toolName: name,
  args,
});

const toolResult = (toolUseId: string, isError: boolean, text: string): ToolResultMessage => ({
  type: 'tool_result',
  id: `r-${toolUseId}`,
  turnId,
  ts: ts + 4,
  toolUseId,
  isError,
  content: { kind: 'text', text },
});

const permission = (
  requestId: string,
  toolUseId: string,
  decision: 'allow' | 'deny',
): PermissionDecisionMessage => ({
  type: 'permission_decision',
  id: requestId,
  turnId,
  ts: ts + 3,
  toolUseId,
  toolName: 'Write',
  decision,
});

const tokens = (input: number, output: number, costUsd?: number): TokenUsageMessage => ({
  type: 'token_usage',
  id: 'tu',
  turnId,
  ts: ts + 5,
  input,
  output,
  ...(costUsd !== undefined ? { costUsd } : {}),
});

const note = (kind: SystemNoteMessage['kind']): SystemNoteMessage => ({
  type: 'system_note',
  id: 'n',
  ts: ts + 6,
  kind,
});

// ---------- materializeSession ----------

describe('materializeSession', () => {
  test('errored tool: result with isError=true → status errored', () => {
    const vm = materializeSession([
      toolCall('t-2', 'Write'),
      toolResult('t-2', true, 'Permission denied'),
    ]);
    expect(vm.items).toHaveLength(1);
    const item = vm.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.item.status).toBe('errored');
    expect(item.item.isError).toBe(true);
  });

  test('cancelled terminal with isError=true → status interrupted', () => {
    const cancelled: ToolResultMessage = {
      type: 'tool_result',
      id: 'r-cancel',
      turnId,
      ts: ts + 4,
      toolUseId: 't-cancel',
      isError: true,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'sleep 99',
        status: 'cancelled',
        exitCode: 130,
        output: {
          mode: 'pipes',
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
    };
    const vm = materializeSession([toolCall('t-cancel', 'Bash'), cancelled]);
    const item = vm.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.item.status).toBe('interrupted');

    const live = applyAppendedMessage(
      applyAppendedMessage([], toolCall('t-cancel', 'Bash')).items,
      cancelled,
    );
    const liveItem = live.items[0];
    if (liveItem?.kind !== 'tool') throw new Error('wrong kind');
    expect(liveItem.item.status).toBe('interrupted');
  });

  test('successful shell_run cancelled observation stays completed', () => {
    // StopBackgroundTask returns isError:false + shell_run.status cancelled —
    // the stop call succeeded; do not map to interrupted/error.
    const observed: ToolResultMessage = {
      type: 'tool_result',
      id: 'r-stop',
      turnId,
      ts: ts + 4,
      toolUseId: 't-stop',
      isError: false,
      content: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/bg',
        mode: 'pipes',
        status: 'cancelled',
        cwd: '/repo',
        cmd: 'sleep 99',
        startedAt: 1,
        updatedAt: 2,
        exitCode: 130,
        revision: 2,
        output: {
          mode: 'pipes',
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
        operation: { kind: 'stop', applied: true },
      },
    };
    const vm = materializeSession([toolCall('t-stop', 'StopBackgroundTask'), observed]);
    const item = vm.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.item.status).toBe('completed');
  });

  test('orphan tool_call (no matching result, no turn record) → interrupted', () => {
    const vm = materializeSession([toolCall('t-orphan', 'Bash')]);
    expect(vm.items).toHaveLength(1);
    const item = vm.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.item.status).toBe('interrupted');
    expect(item.item.result).toBeUndefined();
  });

  // A missing result is the absence of evidence, not evidence of a terminal
  // state. Only a turn that has itself ended makes it mean "never finished" —
  // while the turn runs, so does the call.
  for (const [turnStatus, expected] of [
    ['running', 'running'],
    ['completed', 'interrupted'],
  ] as const) {
    test(`resultless tool_call in a ${turnStatus} turn → ${expected}`, () => {
      const vm = materializeSession([
        {
          type: 'turn_state',
          id: `state-${turnStatus}`,
          turnId,
          ts,
          status: turnStatus,
          partialOutputRetained: false,
        },
        toolCall('t-inflight', 'Bash'),
      ]);
      const item = vm.items[0];
      if (item?.kind !== 'tool') throw new Error('wrong kind');
      expect(item.item.status).toBe(expected);
    });
  }

  test('permission decision folded into tool ChatItem', () => {
    const vm = materializeSession([
      toolCall('t-3', 'Write'),
      permission('req-1', 't-3', 'allow'),
      toolResult('t-3', false, 'ok'),
    ]);
    expect(vm.items).toHaveLength(1);
    const item = vm.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.decision?.decision).toBe('allow');
    expect(item.decision?.id).toBe('req-1');
  });

  test('mixed full conversation', () => {
    const vm = materializeSession([
      note('session_start'),
      user('u1', 'do X'),
      toolCall('t-a', 'Read'),
      toolResult('t-a', false, 'data'),
      assistant('a1', 'Done.'),
      tokens(50, 20),
    ]);
    expect(vm.items.map((i) => i.kind)).toEqual(['system_note', 'user', 'tool', 'assistant']);
    expect(vm.totalTokens.input).toBe(50);
    expect(vm.totalTokens.output).toBe(20);
  });
});

// ---------- applyAppendedMessage ----------

describe('applyAppendedMessage', () => {
  test('preserves a semantic activity kind during reload and live append', () => {
    const call = { ...toolCall('t', 'custom_shell'), activityKind: 'command' as const };
    const reloaded = materializeSession([call]);
    const appended = applyAppendedMessage([], call);

    const reloadedItem = reloaded.items[0];
    const appendedItem = appended.items[0];
    if (reloadedItem?.kind !== 'tool' || appendedItem?.kind !== 'tool')
      throw new Error('wrong kind');
    expect(reloadedItem.item.activityKind).toBe('command');
    expect(appendedItem.item.activityKind).toBe('command');
  });

  test('append tool_result with isError=true → status errored', () => {
    const items = applyAppendedMessage([], toolCall('t', 'Write')).items;
    const next = applyAppendedMessage(items, toolResult('t', true, 'denied'));
    const item = next.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.item.status).toBe('errored');
    expect(item.item.isError).toBe(true);
  });

  test('append tool_result for unknown toolUseId → no-op (list unchanged)', () => {
    const items = applyAppendedMessage([], user('u', 'hello')).items;
    const next = applyAppendedMessage(items, toolResult('nonexistent', false, 'x'));
    expect(next.items).toEqual(items);
  });

  test('append permission_decision → patches tool item.decision', () => {
    const items = applyAppendedMessage([], toolCall('t', 'Write')).items;
    const next = applyAppendedMessage(items, permission('req', 't', 'deny'));
    const item = next.items[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.decision?.decision).toBe('deny');
  });
});

// ---------- setToolStatus (renderer idempotent merge per §10) ----------

describe('setToolStatus', () => {
  test('updates by toolUseId without duplicating', () => {
    const items = applyAppendedMessage([], toolCall('t', 'Read')).items;
    // Two distinct hops off `pending`, so this stays a transition test rather
    // than a second copy of the idempotence test below.
    const stage1 = setToolStatus(items, 't', { status: 'running' });
    const stage2 = setToolStatus(stage1, 't', { status: 'completed' });
    expect(stage2).toHaveLength(1);
    const item = stage2[0];
    if (item?.kind !== 'tool') throw new Error('wrong kind');
    expect(item.item.status).toBe('completed');
  });

  test('idempotent on duplicate updates', () => {
    const items = applyAppendedMessage([], toolCall('t', 'Read')).items;
    const once = setToolStatus(items, 't', { status: 'running' });
    const twice = setToolStatus(once, 't', { status: 'running' });
    expect(twice).toEqual(once);
  });
});
