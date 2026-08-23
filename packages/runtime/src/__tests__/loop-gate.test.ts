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

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { SessionEvent, ToolResultContent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';

import {
  ToolRuntime,
  formatLoopGateText,
  formatAmbiguousComputerLoopGateText,
  formatDeferredNotLoadedText,
  LOOP_GATE_IDENTICAL_THRESHOLD,
  type MakaTool,
} from '../tool-runtime.js';

type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;
type ObservedShellRunStatus = Extract<
  ShellRunToolResult['status'],
  'failed' | 'timed_out' | 'cancelled' | 'orphaned'
>;
const observedShellRunStatuses = [
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
] as const satisfies readonly ObservedShellRunStatus[];

// The loop-gate blocks a back-to-back run of byte-identical tool calls (same
// tool + same args) only after they have FAILED N-1 times in a row (#92). A
// success — or any different call — resets the streak, so legitimate polling and
// iterate-then-retry are never gated. These tests drive ToolRuntime directly so
// the path resolves synchronously (no streaming, no permission parking).

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

interface Harness {
  runtime: ToolRuntime;
  pushed: SessionEvent[];
  impl: string[];
  invocations: Array<Pick<ToolInvocationRecord, 'toolName' | 'status'>>;
}

function makeHarness(): Harness {
  const appended: StoredMessage[] = [];
  const pushed: SessionEvent[] = [];
  const impl: string[] = [];
  const invocations: Array<Pick<ToolInvocationRecord, 'toolName' | 'status'>> = [];
  let n = 0;
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (m) => {
      appended.push(m);
    },
    newId: () => `id-${++n}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
    recordToolInvocation: (record) => {
      invocations.push({ toolName: record.toolName, status: record.status });
    },
  });
  return { runtime, pushed, impl, invocations };
}

// A tool that succeeds (returns {ok:true}). Used for the polling / no-gate cases.
function makeTool(name: string, impl: string[]): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    impl: (args) => {
      impl.push(`${name}:${JSON.stringify(args)}`);
      return { ok: true };
    },
  };
}

// A tool that always throws — its synthetic error counts as a loop-gate failure.
function makeFailingTool(name: string, impl: string[], message = 'boom'): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    impl: (args) => {
      impl.push(`${name}:${JSON.stringify(args)}`);
      throw new Error(message);
    },
  };
}

// A tool whose outcome flips with `box.fail`, so one tool can both fail and
// succeed across calls (for the success-resets-the-streak case).
function makeFlakyTool(
  name: string,
  impl: string[],
  box: { fail: boolean },
  message = 'boom',
): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    impl: (args) => {
      impl.push(`${name}:${JSON.stringify(args)}`);
      if (box.fail) throw new Error(message);
      return { ok: true };
    },
  };
}

// A tool that RETURNS a terminal result instead of throwing. Terminal status
// must be classified by deriveToolResultStatus() for the loop-gate to see
// failures.
function makeTerminalTool(name: string, impl: string[], exitCode: number): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    impl: (args) => {
      impl.push(`${name}:${JSON.stringify(args)}`);
      return {
        kind: 'terminal',
        cwd: '/tmp/maka',
        cmd: 'cmd',
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        output: {
          mode: 'pipes',
          stdout: '',
          stderr: exitCode === 0 ? '' : 'boom\n',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      };
    },
  };
}

function makeShellRunTool(name: string, impl: string[], status: ObservedShellRunStatus): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    impl: (args) => {
      impl.push(`${name}:${JSON.stringify(args)}`);
      return {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/shell-run-1',
        mode: 'pipes',
        status,
        cwd: '/tmp/maka',
        cmd: 'cmd',
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        ...(status === 'orphaned'
          ? { failureMessage: 'missing live shell process handle' }
          : {
              exitCode: status === 'timed_out' ? 124 : status === 'cancelled' ? 130 : 1,
              failureMessage:
                status === 'timed_out'
                  ? 'Command timed out after 10000ms'
                  : status === 'cancelled'
                    ? 'Command cancelled'
                    : 'Command failed',
            }),
        revision: 2,
        output: {
          mode: 'pipes',
          stdout: '',
          stderr: status === 'failed' ? 'boom\n' : '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      } satisfies ShellRunToolResult;
    },
  };
}

function makeComputerFailureTool(impl: string[], failureClass?: 'ambiguous_target'): MakaTool {
  return {
    name: 'maka_computer',
    description: 'computer',
    parameters: z.object({}).passthrough(),
    categoryHint: 'computer_use',
    permissionArgs: (args) => {
      const record = args as Record<string, unknown>;
      return record.action === 'observe'
        ? record
        : {
            ...record,
            app: 'Fixture',
            window_id: 7,
            element_identity: {
              token: `snapshot:${String(record.element_id ?? 'unknown')}`,
              role: 'AXButton',
              label: 'Duplicate',
            },
          };
    },
    impl: (args) => {
      impl.push(JSON.stringify(args));
      if ((args as { action?: string }).action === 'observe') {
        return { text: 'observed' };
      }
      return {
        text: 'maka_computer failed: stale_frame',
        error: 'stale_frame',
        ...(failureClass ? { failureClass } : {}),
      };
    },
  };
}

let callSeq = 0;
function call(
  h: Harness,
  t: MakaTool,
  args: unknown,
  turnId = 'turn-1',
  origin: 'provider' | 'code_mode' = 'provider',
): Promise<unknown> {
  return h.runtime
    .settleToolCall({
      tool: t,
      turnId,
      toolCallId: `tc-${++callSeq}`,
      input: args,
      origin,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => h.pushed.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          h.pushed.push(event);
        },
      },
    })
    .then((settlement) => settlement.result);
}

describe('loop-gate for repeated identical FAILING tool calls', () => {
  test('keeps nested CodeMode failures out of the provider loop-gate streak', async () => {
    const h = makeHarness();
    const t = makeFailingTool('Read', h.impl);
    const args = { path: 'README.md' };

    await call(h, t, args, 'turn-1', 'code_mode');
    await call(h, t, args, 'turn-1', 'code_mode');
    const providerResult = await call(h, t, args, 'turn-1', 'provider');

    assert.deepEqual(providerResult, { error: 'boom' });
    assert.equal(h.impl.length, 3);
  });

  test('runs the first N-1 identical failing calls then blocks the Nth (and keeps blocking)', async () => {
    const h = makeHarness();
    const t = makeFailingTool('Edit', h.impl, 'edit failed');
    const args = { path: 'a.ts', old_string: 'x', new_string: 'y' };

    const results: unknown[] = [];
    for (let i = 0; i < LOOP_GATE_IDENTICAL_THRESHOLD; i++) results.push(await call(h, t, args));

    assert.equal(
      h.impl.length,
      LOOP_GATE_IDENTICAL_THRESHOLD - 1,
      'only the calls before the gate ran',
    );
    assert.deepEqual(results[LOOP_GATE_IDENTICAL_THRESHOLD - 1], {
      error: formatLoopGateText('Edit'),
    });

    const again = await call(h, t, args);
    assert.deepEqual(
      again,
      { error: formatLoopGateText('Edit') },
      'further identical calls stay blocked',
    );
    assert.equal(h.impl.length, LOOP_GATE_IDENTICAL_THRESHOLD - 1, 'no further impl runs');
  });

  test('identical SUCCEEDING calls are never gated — polling is allowed', async () => {
    const h = makeHarness();
    const poll = makeTool('Bash', h.impl);
    const args = { command: 'git status --porcelain' };

    const runs = LOOP_GATE_IDENTICAL_THRESHOLD + 2;
    const results: unknown[] = [];
    for (let i = 0; i < runs; i++) results.push(await call(h, poll, args));

    assert.equal(h.impl.length, runs, 'every successful poll ran');
    assert.deepEqual(
      results,
      Array.from({ length: runs }, () => ({ ok: true })),
      'no poll was gated',
    );
  });

  test('a success between failures resets the streak', async () => {
    const h = makeHarness();
    const box = { fail: true };
    const t = makeFlakyTool('Bash', h.impl, box);
    const args = { command: 'npm test' };

    box.fail = true;
    await call(h, t, args); // fail → streak 1
    box.fail = false;
    await call(h, t, args); // success → streak reset to 0
    box.fail = true;
    await call(h, t, args); // fail → streak 1
    const stillRuns = await call(h, t, args); // fail → streak 2 (was 1 at the gate, so it ran)

    assert.deepEqual(
      stillRuns,
      { error: 'boom' },
      'the success reset the streak, so this still ran',
    );
    assert.equal(h.impl.length, 4, 'all four ran — the success prevented an early block');

    // Only now, after two fresh back-to-back failures, is the next identical call blocked.
    const blocked = await call(h, t, args);
    assert.deepEqual(
      blocked,
      { error: formatLoopGateText('Bash') },
      'blocked after two fresh failures',
    );
    assert.equal(h.impl.length, 4, 'the blocked call did not run');
  });

  test('a different tool or args between failures resets the streak', async () => {
    const h = makeHarness();
    const bash = makeFailingTool('Bash', h.impl);
    const edit = makeFailingTool('Edit', h.impl);
    const cmd = { command: 'npm test' };

    // Three identical Bash failures, but never back-to-back — iterate-then-retry
    // (fail a test, edit, re-run the same failing test) must not be gated.
    await call(h, bash, cmd);
    await call(h, edit, { path: 'a' });
    await call(h, bash, cmd);
    await call(h, edit, { path: 'a' });
    const last = await call(h, bash, cmd);

    assert.deepEqual(last, { error: 'boom' }, 'the re-run after a different call is not blocked');
    assert.equal(h.impl.length, 5, 'all five calls ran');
  });

  test('treats args as identical regardless of key order', async () => {
    const h = makeHarness();
    const t = makeFailingTool('Write', h.impl);

    await call(h, t, { path: 'a', content: 'x' }); // fail → streak 1
    await call(h, t, { content: 'x', path: 'a' }); // same canonical args → fail → streak 2
    const third = await call(h, t, { path: 'a', content: 'x' }); // blocked

    assert.deepEqual(third, { error: formatLoopGateText('Write') });
    assert.equal(h.impl.length, 2);
  });

  test('the block is recoverable — a different call afterwards still runs', async () => {
    const h = makeHarness();
    const grep = makeFailingTool('Grep', h.impl);
    const read = makeTool('Read', h.impl);
    const args = { pattern: 'foo' };

    for (let i = 0; i < LOOP_GATE_IDENTICAL_THRESHOLD; i++) await call(h, grep, args);
    assert.ok(
      h.pushed.some((e) => e.type === 'tool_result' && e.isError && e.toolUseId.startsWith('tc-')),
      'a synthetic error result is emitted for the blocked call',
    );

    await call(h, read, { path: 'x' });
    assert.ok(h.impl.includes('Read:{"path":"x"}'), 'a different call after a block runs normally');
  });

  test('a repeatedly not-loaded tool trips the gate — guard rejections count as failures', async () => {
    const h = makeHarness();
    const gated = makeTool('browser_click', h.impl);
    // browser_click is gated and never active this turn, so the availability guard
    // rejects every call before it runs. The first N-1 rejections give the
    // actionable load hint; the Nth identical rejection is loop-gated.
    h.runtime.setGating({ gatedNames: new Set(['browser_click']), activeNames: () => new Set() });
    const args = { sel: '#x' };

    const r1 = await call(h, gated, args);
    const r2 = await call(h, gated, args);
    const r3 = await call(h, gated, args);

    assert.deepEqual(
      r1,
      { error: formatDeferredNotLoadedText('browser_click') },
      'first: load hint',
    );
    assert.deepEqual(
      r2,
      { error: formatDeferredNotLoadedText('browser_click') },
      'second: load hint',
    );
    assert.deepEqual(r3, { error: formatLoopGateText('browser_click') }, 'third: loop-gated');
    assert.equal(h.impl.length, 0, 'the gated tool never actually ran');
  });

  test('the failure streak is per-turn: a turn reset clears it so a new turn is not falsely blocked', async () => {
    const h = makeHarness();
    const t = makeFailingTool('Edit', h.impl);
    const args = { path: 'a.ts', old_string: 'x', new_string: 'y' };

    // Two identical failures in the first turn — the streak builds to N-1 but the
    // gate has not fired yet, so both run.
    await call(h, t, args, 'turn-1');
    await call(h, t, args, 'turn-1');
    assert.equal(h.impl.length, 2, 'both first-turn failures ran');

    // ToolRuntime state is per-instance, not auto-keyed on turnId: a third
    // identical failing call carrying a NEW turn id but with no reset is still the
    // 3rd back-to-back failure and is blocked. This is exactly why send() must
    // reset per turn rather than relying on the turn id alone.
    const withoutReset = await call(h, t, args, 'turn-2');
    assert.deepEqual(
      withoutReset,
      { error: formatLoopGateText('Edit') },
      'without a reset the streak leaks across turns',
    );

    // send() resets ToolRuntime at each turn boundary (at turn start, and via
    // cleanupAfterTurn at turn end). After the reset, the same call is the first
    // of a fresh turn and runs (failing on its own merits) — not mistaken for a
    // 3rd repeat.
    h.runtime.resetTurnState();
    const afterReset = await call(h, t, args, 'turn-3');
    assert.deepEqual(
      afterReset,
      { error: 'boom' },
      'after the per-turn reset the identical call runs again',
    );
    assert.equal(h.impl.length, 3, 'the post-reset call ran');
  });

  // A Bash adapter may return a terminal result instead of throwing, so its failure
  // is counted only when deriveToolResultStatus() classifies the terminal exitCode.
  test('a returned terminal result with a non-zero exit counts as a failure', async () => {
    const h = makeHarness();
    const t = makeTerminalTool('Bash', h.impl, 1);
    const args = { command: 'npm test' };

    const results: unknown[] = [];
    for (let i = 0; i < LOOP_GATE_IDENTICAL_THRESHOLD; i++) results.push(await call(h, t, args));

    assert.equal(
      h.impl.length,
      LOOP_GATE_IDENTICAL_THRESHOLD - 1,
      'impl ran only before the gate fired',
    );
    for (let i = 0; i < LOOP_GATE_IDENTICAL_THRESHOLD - 1; i++) {
      assert.equal(
        (results[i] as { kind?: string }).kind,
        'terminal',
        'failing runs still return their terminal output',
      );
    }
    assert.deepEqual(
      results[LOOP_GATE_IDENTICAL_THRESHOLD - 1],
      { error: formatLoopGateText('Bash') },
      'the Nth identical failure is gated',
    );
  });

  test('a returned terminal result with exit 0 is a success — polling is not gated', async () => {
    const h = makeHarness();
    const t = makeTerminalTool('Bash', h.impl, 0);
    const args = { command: 'git status --porcelain' };

    const runs = LOOP_GATE_IDENTICAL_THRESHOLD + 2;
    for (let i = 0; i < runs; i++) await call(h, t, args);

    assert.equal(h.impl.length, runs, 'every exit-0 poll ran — none was gated');
  });

  test('returned shell_run terminal states are observations, not tool failures', async () => {
    for (const status of observedShellRunStatuses) {
      const h = makeHarness();
      const t = makeShellRunTool('StopBackgroundTask', h.impl, status);
      const args = { ref: 'maka://runtime/background-tasks/shell-run-1' };

      const result = await call(h, t, args);
      assert.equal((result as { kind?: string }).kind, 'shell_run', status);
      const event = h.pushed.find((candidate) => candidate.type === 'tool_result');
      assert.equal(event?.type === 'tool_result' ? event.isError : true, false, status);
      assert.equal(h.invocations[0]?.status, 'success', status);
    }
  });

  test('a returned top-level error is classified as a failed tool result', async () => {
    const h = makeHarness();
    const tool = makeComputerFailureTool(h.impl);
    const result = await call(h, tool, {
      action: 'click_element',
      observation_id: 'obs-1',
      element_id: 'duplicate',
    });
    assert.deepEqual(result, {
      text: 'maka_computer failed: stale_frame',
      error: 'stale_frame',
    });
    const event = h.pushed.find((candidate) => candidate.type === 'tool_result');
    assert.equal(event?.type === 'tool_result' ? event.isError : false, true);
    assert.equal(h.invocations[0]?.status, 'error');
  });

  test('an ambiguous semantic target is gated across fresh observation ids', async () => {
    const h = makeHarness();
    const tool = makeComputerFailureTool(h.impl, 'ambiguous_target');
    const first = await call(h, tool, {
      action: 'click_element',
      observation_id: 'obs-1',
      element_id: 'duplicate',
    });
    assert.equal((first as { error?: string }).error, 'stale_frame');

    await call(h, tool, {
      action: 'observe',
      app: 'Fixture',
    });
    const second = await call(h, tool, {
      action: 'click_element',
      observation_id: 'obs-2',
      element_id: 'renumbered-duplicate',
    });
    assert.deepEqual(second, { error: formatAmbiguousComputerLoopGateText() });
    assert.equal(
      h.impl.length,
      2,
      'observe runs but the repeated mutation never reaches the backend',
    );
  });

  test('repeated shell_run observations are not loop-gated by process status', async () => {
    const h = makeHarness();
    const t = makeShellRunTool('StopBackgroundTask', h.impl, 'timed_out');
    const args = { ref: 'maka://runtime/background-tasks/shell-run-1' };

    const runs = LOOP_GATE_IDENTICAL_THRESHOLD + 2;
    for (let i = 0; i < runs; i++) await call(h, t, args);

    assert.equal(h.impl.length, runs, 'every background-task observation ran');
    assert.equal(
      h.pushed.every((event) => event.type !== 'tool_result' || event.isError === false),
      true,
      'ShellRun observations do not surface as tool errors',
    );
  });
});
