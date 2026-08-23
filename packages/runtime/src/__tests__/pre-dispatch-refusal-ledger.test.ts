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
import { test } from 'node:test';

import { type LlmConnection } from '@maka/core/llm-connections';

import { type RuntimeEvent } from '@maka/core/runtime-event';

import { type SessionEvent } from '@maka/core/events';

import { type SessionHeader } from '@maka/core/session';
import { scanToolLedger } from '@maka/core/tool-ledger-scanner';
import { z } from 'zod';

import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import type { RuntimeCommitSink } from '../runtime-commit-sink.js';
import { LOOP_GATE_IDENTICAL_THRESHOLD, type MakaTool, type ToolRuntime } from '../tool-runtime.js';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';

/**
 * A pre-dispatch refusal must leave the ledger a matched call/response pair.
 *
 * The lane is the whole point. A call tagged with an `operationId` is claimed by
 * the T1 dispatch protocol, so AgentRun skips its generic projection and waits
 * for `commitToolPrepared` to persist it — which a refusal never reaches.
 * Tagging the call while putting the refusal on the generic lane produced an
 * `orphan_response`; the ledger refused that append, the append threw, and a
 * recoverable refusal killed the whole turn (issue #2234). These tests assemble
 * the ledger the way production does — the commit sink's events plus the mapped
 * queue events minus the ones AgentRun skips — and assert the scanner is clean.
 */

const SESSION_ID = 'session-1';
const RUN_ID = 'run-1';
const INVOCATION_ID = 'invocation-1';
const TURN_ID = 'turn-1';

/** Batch-like per-item cross-field validation, which is what DeepSeek tripped. */
const swarmLikeSchema = z
  .object({
    items: z.array(
      z
        .object({
          item_id: z.string(),
          task: z.string(),
          profile: z.string().optional(),
          subagent_id: z.string().optional(),
        })
        .superRefine((item, ctx) => {
          if (Boolean(item.profile) === Boolean(item.subagent_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Provide exactly one of subagent_id or legacy profile.',
            });
          }
        }),
    ),
  })
  .strict();

interface LedgerHarness {
  events: SessionEvent[];
  committed: RuntimeEvent[];
  sink: RuntimeCommitSink;
}

function harness(): LedgerHarness {
  const events: SessionEvent[] = [];
  const committed: RuntimeEvent[] = [];
  let seq = 0;
  return {
    events,
    committed,
    sink: {
      commitToolPrepared: async (input) => {
        committed.push(input.runtimeEvent, input.dispatchRuntimeEvent);
        return { created: true, runtimeEventSeq: (seq += 2) };
      },
      commitToolOutcome: async (input) => {
        committed.push(input.runtimeEvent);
        return { created: true, runtimeEventSeq: (seq += 1) };
      },
    },
  };
}

/**
 * The ledger as the store would see it: what the commit sink persisted, plus the
 * mapped queue events AgentRun does append. `isAtomicToolBoundaryProjection` is
 * mirrored here — a protocol-tagged call/response is the sink's to write, so the
 * generic lane skips it rather than duplicating the fact.
 */
function projectLedger(h: LedgerHarness): RuntimeEvent[] {
  const memory = createSessionEventMapMemory();
  const ctx = {
    sessionId: SESSION_ID,
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    source: 'test',
    startedAt: 1,
    request: { sessionId: SESSION_ID, turnId: TURN_ID, text: '', source: 'test' },
    newId: () => 'unused',
    now: () => 1,
  } satisfies InvocationContext;
  const generic = h.events
    .map((event) => mapSessionEventToRuntimeEvent(event, ctx, memory))
    .filter((event) => {
      const atomic =
        event.refs?.operationId !== undefined &&
        (event.content?.kind === 'function_call' || event.content?.kind === 'function_response');
      return !atomic && !event.partial;
    });
  return [...h.committed, ...generic];
}

function runtimeInput(h: LedgerHarness) {
  return {
    sessionId: SESSION_ID,
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    runtimeCommitSink: h.sink,
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  };
}

function runtimeFor(h: LedgerHarness) {
  return createTestToolRuntime(runtimeInput(h));
}

function settle(
  h: LedgerHarness,
  tool: MakaTool,
  input: unknown,
  options: { runtime?: ToolRuntime; toolCallId?: string; stepId?: string } = {},
) {
  return (options.runtime ?? runtimeFor(h)).settleToolCall({
    tool,
    turnId: TURN_ID,
    toolCallId: options.toolCallId ?? 'call_00_swarm',
    ...(options.stepId ? { stepId: options.stepId } : {}),
    input,
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => h.events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        h.events.push(event);
      },
    },
  });
}

/** Every issue the scanner raised, so a failure names what actually broke. */
function ledgerIssues(h: LedgerHarness): string[] {
  const scan = scanToolLedger(projectLedger(h));
  return scan.issues.map((issue) => `${issue.code}@${issue.eventId}`);
}

const swarmTool: MakaTool = {
  name: 'exclusive_batch',
  description: 'test',
  parameters: swarmLikeSchema,
  impl: async () => {
    assert.fail('invalid arguments must not reach the implementation');
  },
};

/**
 * Every pre-dispatch refusal, not just the one that produced the bug report.
 *
 * These are the paths the old construction-time predicate had to enumerate
 * correctly; the push-time model has to keep them on the generic lane by
 * construction instead. Driving each one end to end is what turns "the
 * enumeration currently agrees with the guards" into something a future edit
 * cannot quietly break.
 *
 * Not covered here: the subagent cap needs five settlements held open
 * concurrently, and that interacts with the slot release path rather than the
 * lane; `subagent-tool-limit` in the runtime suite owns it.
 */
const REFUSAL_PATHS: Array<{
  name: string;
  expect: RegExp;
  drive: (h: LedgerHarness) => Promise<{ result: unknown }>;
}> = [
  {
    name: 'arguments rejected by the schema',
    expect: /arguments failed validation/,
    drive: (h) => settle(h, swarmTool, { items: [{ item_id: 'a', task: 'one' }] }),
  },
  {
    name: 'exclusive-step admission',
    expect: /cannot share an assistant step/,
    drive: async (h) => {
      // An `exclusive_step` tool refuses the second call in one step.
      const runtime = runtimeFor(h);
      const ok = { items: [{ item_id: 'a', task: 'one', subagent_id: 'reviewer' }] };
      const tool: MakaTool = {
        ...swarmTool,
        executionSemantics: 'exclusive_step',
        impl: async () => ({ ok: true }),
      };
      await settle(h, tool, ok, { runtime, toolCallId: 'call_first', stepId: 'step-1' });
      return settle(h, tool, ok, { runtime, toolCallId: 'call_second', stepId: 'step-1' });
    },
  },
  {
    name: 'loop gate on a repeated identical failing call',
    expect: /already failed repeatedly/,
    drive: async (h) => {
      const runtime = runtimeFor(h);
      const tool: MakaTool = {
        name: 'Bash',
        description: 'test',
        parameters: z.object({ command: z.string() }),
        impl: async () => {
          throw new Error('always fails');
        },
      };
      const input = { command: 'false' };
      let last: { result: unknown } = { result: undefined };
      // The streak is keyed on the args, so distinct call ids still repeat it.
      for (let attempt = 0; attempt < LOOP_GATE_IDENTICAL_THRESHOLD; attempt += 1) {
        last = await settle(h, tool, input, { runtime, toolCallId: `call_loop_${attempt}` });
      }
      return last;
    },
  },
  {
    name: 'loop gate on a repeated ambiguous Computer Use target',
    expect: /ambiguous|same target/i,
    drive: async (h) => {
      const runtime = runtimeFor(h);
      const tool: MakaTool = {
        name: 'maka_computer',
        description: 'test',
        categoryHint: 'computer_use',
        parameters: z.object({
          action: z.string(),
          app: z.string(),
          element_id: z.string(),
        }),
        // The result shape that arms the ambiguous-target gate.
        impl: async () => ({ error: 'stale_frame', failureClass: 'ambiguous_target' }),
      };
      const input = { action: 'click_element', app: 'Finder', element_id: '4' };
      await settle(h, tool, input, { runtime, toolCallId: 'call_cu_first' });
      return settle(h, tool, input, { runtime, toolCallId: 'call_cu_second' });
    },
  },
  {
    name: 'deferred tool used before its load',
    expect: /load_tools/,
    drive: async (h) => {
      const runtime = runtimeFor(h);
      runtime.setGating({ gatedNames: new Set(['Deferred']), activeNames: () => new Set() });
      const tool: MakaTool = {
        name: 'Deferred',
        description: 'test',
        parameters: z.object({}),
        impl: async () => ({ ok: true }),
      };
      return settle(h, tool, {}, { runtime, toolCallId: 'call_deferred' });
    },
  },
  {
    name: 'client-capability boundary read failure',
    expect: /boundary read exploded/,
    drive: (h) => {
      const runtime = createTestToolRuntime({
        ...runtimeInput(h),
        readExecutionBoundary: async () => {
          throw new Error('boundary read exploded');
        },
      });
      const tool: MakaTool = {
        name: 'browser_click',
        description: 'test',
        categoryHint: 'client_capability',
        parameters: z.object({}),
        impl: async () => ({ ok: true }),
      };
      return settle(h, tool, {}, { runtime, toolCallId: 'call_boundary_read' });
    },
  },
  {
    name: 'client-capability blocked by the execution boundary',
    expect: /require the Bypass execution boundary/,
    drive: (h) => {
      // The default test boundary is `external`, not `bypass`.
      const tool: MakaTool = {
        name: 'browser_click',
        description: 'test',
        categoryHint: 'client_capability',
        parameters: z.object({}),
        impl: async () => ({ ok: true }),
      };
      return settle(h, tool, {}, { toolCallId: 'call_boundary_blocked' });
    },
  },
];

for (const path of REFUSAL_PATHS) {
  test(`refusal keeps the ledger clean: ${path.name}`, async () => {
    const h = harness();
    const { result } = await path.drive(h);

    // It is a refusal, and it is the one this row means.
    const refusal = (result as { error?: string }).error ?? '';
    assert.notEqual(refusal, '', 'expected a refusal, got a successful result');
    assert.match(refusal, path.expect);

    // And the ledger it leaves behind has no orphan and no lane conflict.
    assert.deepEqual(ledgerIssues(h), []);

    // The refused call itself never claims the T1 lane.
    const scan = scanToolLedger(projectLedger(h));
    const refused = scan.operations.at(-1);
    assert.equal(refused?.dispatchEvent, undefined);
    assert.ok(refused?.callEvent, 'the refusal left no call fact at all');
    assert.ok(refused?.responseEvent, 'the refusal left no response fact');
  });
}

test('arguments the schema rejects leave a matched call/response pair on the generic lane', async () => {
  const h = harness();

  const { result } = await settle(h, swarmTool, {
    items: [
      { item_id: 'a', task: 'one', subagent_id: 'reviewer' },
      { item_id: 'b', task: 'two', subagent_id: 'reviewer' },
      // The third item names neither selector — one slip out of three.
      { item_id: 'c', task: 'three' },
    ],
  });

  // The refusal still reaches the model, unchanged.
  assert.match(
    (result as { error?: string }).error ?? '',
    /Tool "exclusive_batch" arguments failed validation/,
  );

  // Nothing crossed T1: no prepared/dispatch/outcome commit for a call that
  // never ran.
  assert.deepEqual(h.committed, []);

  const ledger = projectLedger(h);
  const scan = scanToolLedger(ledger);
  assert.deepEqual(
    scan.issues.map((issue) => issue.code),
    [],
    `pre-dispatch refusal corrupted the ledger: ${JSON.stringify(scan.issues)}`,
  );
  assert.equal(scan.hasCorruption, false);

  // The pair the scanner matched is the refusal's own, and it is untagged —
  // both halves on the generic lane.
  const [operation, ...extra] = scan.operations;
  assert.deepEqual(extra, []);
  assert.equal(operation?.toolCallId, 'call_00_swarm');
  assert.equal(operation?.operationId, undefined);
  assert.equal(operation?.callEvent?.content?.kind, 'function_call');
  assert.equal(operation?.responseEvent?.content?.kind, 'function_response');
  assert.equal(operation?.dispatchEvent, undefined);
});

test('a dispatched call still claims the T1 lane and settles through the commit sink', async () => {
  const h = harness();
  const tool: MakaTool = {
    name: 'exclusive_batch',
    description: 'test',
    parameters: swarmLikeSchema,
    impl: async () => ({ ok: true }),
  };

  const { result } = await settle(h, tool, {
    items: [{ item_id: 'a', task: 'one', subagent_id: 'reviewer' }],
  });
  assert.deepEqual(result, { ok: true });

  // Call, dispatch and outcome are the sink's three facts, all under one id.
  const operationIds = new Set(h.committed.map((event) => event.refs?.operationId));
  assert.equal(operationIds.size, 1);
  const [operationId] = [...operationIds];
  assert.ok(operationId?.startsWith('toolop_'), `unexpected operation id ${operationId}`);

  const scan = scanToolLedger(projectLedger(h));
  assert.deepEqual(
    scan.issues.map((issue) => issue.code),
    [],
    `dispatched call corrupted the ledger: ${JSON.stringify(scan.issues)}`,
  );
  const [operation, ...extra] = scan.operations;
  assert.deepEqual(extra, []);
  assert.equal(operation?.operationId, operationId);
  assert.ok(operation?.callEvent, 'the T1 call fact is missing');
  assert.ok(operation?.dispatchEvent, 'the T1 dispatch fact is missing');
  assert.ok(operation?.responseEvent, 'the T1 outcome fact is missing');
});

function nextId(): () => string {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function header(): SessionHeader {
  return {
    id: SESSION_ID,
    workspaceRoot: '/workspace',
    cwd: '/workspace',
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
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.invalid',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
