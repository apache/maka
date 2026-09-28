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

import { nextId } from '@maka/core/test-only/async-primitives';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import type {
  RuntimeCommitSink,
  ToolOutcomeCommit,
  ToolPreparedCommit,
} from '../runtime-commit-sink.js';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

describe('ToolRuntime durable boundary', () => {
  it('does not invoke the tool or publish a result when T1 fails', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        throw new Error('T1 unavailable');
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /T1 unavailable/,
    );

    assert.equal(implementationCalls, 0);
    assert.deepEqual(harness.events, []);
    assert.deepEqual(harness.messages, []);
  });

  it('publishes no call side effects when another dispatcher owns the operation', async () => {
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: false, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /already claimed/,
    );

    assert.equal(implementationCalls, 0);
    assert.deepEqual(harness.events, []);
    assert.deepEqual(harness.messages, []);
  });

  it('refuses durable tool execution when the turn carries no run id', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => {
          preparedCalls += 1;
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async () => {
          throw new Error('must not reach T2');
        },
      },
      undefined,
      null,
    );

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /Durable tool execution requires a run id/,
    );

    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
  });

  it('does not cross T1 when durable dispatch is already aborted', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error('stop before start'));
    const harness = makeHarness({
      commitToolPrepared: async () => {
        preparedCalls += 1;
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => {
        throw new Error('must not reach T2');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
        controller.signal,
      ),
      /stop before start/,
    );

    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
  });

  it('commits T1 before implementation and T2 before publishing the result', async () => {
    const order: string[] = [];
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness(
      {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          order.push('t1');
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async (input) => {
          outcomes.push(input);
          order.push('t2');
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      order,
    );

    const result = await harness.execute(
      tool(() => {
        order.push('impl');
        return { ok: true, text: 'done' };
      }),
    );

    assert.deepEqual(result, { ok: true, text: 'done' });
    assert.deepEqual(order, ['t1', 'impl', 't2', 'published-result']);
    assert.equal(prepared[0]?.runtimeEvent.content?.kind, 'function_call');
    assert.equal(
      prepared[0]?.dispatchRuntimeEvent.actions?.toolDispatch?.protocol,
      't1_after_preflight_v1',
    );
    assert.equal(
      prepared[0]?.dispatchRuntimeEvent.actions?.toolDispatch?.resultProjectionVersion,
      1,
    );
    assert.equal(prepared[0]?.dispatchRuntimeEvent.content, undefined);
    assert.equal(outcomes[0]?.runtimeEvent.content?.kind, 'function_response');
    assert.equal(prepared[0]?.operationId, outcomes[0]?.operationId);
    assert.equal(prepared[0]?.runtimeEvent.refs?.operationId, prepared[0]?.operationId);
    assert.equal(prepared[0]?.dispatchRuntimeEvent.refs?.operationId, prepared[0]?.operationId);
    assert.equal(outcomes[0]?.runtimeEvent.refs?.operationId, prepared[0]?.operationId);
  });

  it('commits the completed outcome with its model projection in T2', async () => {
    const order: string[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        order.push('t2');
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const projectedTool = tool(() => ({ private: 'raw execution fact' }));
    projectedTool.toModelOutput = () => {
      order.push('project');
      return { type: 'text', value: 'bounded model fact' };
    };

    await harness.execute(projectedTool);

    assert.deepEqual(order, ['project', 't2']);
    const response = outcomes[0]?.runtimeEvent.content;
    assert.deepEqual(
      response?.kind === 'function_response' ? response.modelProjection : undefined,
      {
        version: 1,
        kind: 'text',
        text: 'bounded model fact',
      },
    );
  });

  it('commits one deterministic fallback when projection fails', async () => {
    let implementationCalls = 0;
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const unprojectableTool = tool(() => {
      implementationCalls += 1;
      return { private: 'completed execution fact' };
    });
    unprojectableTool.toModelOutput = () => {
      throw new Error('projection implementation failed');
    };

    assert.deepEqual(await harness.execute(unprojectableTool), {
      private: 'completed execution fact',
    });

    assert.equal(implementationCalls, 1);
    assert.equal(outcomes.length, 1);
    const response = outcomes[0]?.runtimeEvent.content;
    assert.deepEqual(
      response?.kind === 'function_response' ? response.modelProjection : undefined,
      {
        version: 1,
        kind: 'failure',
        reason: 'projection_failed',
        message: 'The tool completed, but its model-visible result could not be projected safely.',
      },
    );
  });

  it('commits fallback instead of awaiting an asynchronous projector', {
    timeout: 1_000,
  }, async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const invalidTool = tool(() => ({ private: 'completed execution fact' }));
    invalidTool.toModelOutput = (() =>
      new Promise<never>(() => undefined)) as unknown as NonNullable<MakaTool['toModelOutput']>;

    await harness.execute(invalidTool);

    const response = outcomes[0]?.runtimeEvent.content;
    assert.deepEqual(
      response?.kind === 'function_response' ? response.modelProjection : undefined,
      {
        version: 1,
        kind: 'failure',
        reason: 'projection_failed',
        message: 'The tool completed, but its model-visible result could not be projected safely.',
      },
    );
  });

  it('persists inline image output as a Session artifact before committing T2', async () => {
    const order: string[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const artifactRef = {
      kind: 'session_file' as const,
      sessionId: 'session-1',
      relativePath: 'artifact-1',
    };
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async (input) => {
          outcomes.push(input);
          order.push('t2');
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        prepareDurableProjectionArtifact: (input) => {
          assert.equal(input.turnId, 'turn-1');
          assert.equal(input.mediaType, 'image/png');
          assert.deepEqual([...input.bytes], [137, 80, 78, 71]);
          return {
            ref: artifactRef,
            persist: async () => {
              order.push('artifact');
            },
          };
        },
      },
    );
    const imageTool = tool(() => ({ private: 'raw execution fact' }));
    imageTool.toModelOutput = () => ({
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'data', data: Buffer.from([137, 80, 78, 71]).toString('base64') },
          mediaType: 'image/png',
        },
      ],
    });

    await harness.execute(imageTool);

    assert.deepEqual(order, ['artifact', 't2']);
    const response = outcomes[0]?.runtimeEvent.content;
    assert.deepEqual(
      response?.kind === 'function_response' ? response.modelProjection : undefined,
      {
        version: 1,
        kind: 'content',
        parts: [{ kind: 'artifact', mediaType: 'image/png', ref: artifactRef }],
      },
    );
    assert.doesNotMatch(JSON.stringify(response), /iVBORw/);
  });

  it('rejects an oversized nested result before durable publication', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const oversized = { text: 'x'.repeat(128) };

    const result = await harness.executeNested(
      tool(() => oversized),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(JSON.stringify(harness.events).includes(oversized.text), false);
    const durableResult = outcomes[0]?.runtimeEvent.content;
    assert.equal(
      durableResult?.kind === 'function_response'
        ? JSON.stringify(durableResult.result).includes(oversized.text)
        : false,
      false,
    );
  });

  it('uses serialized bytes before publishing a nested string result', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    const result = await harness.executeNested(
      tool(() => '\0'.repeat(10)),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.runtimeEvent.content?.kind, 'function_response');
    assert.equal(
      outcomes[0]?.runtimeEvent.content?.kind === 'function_response' &&
        outcomes[0].runtimeEvent.content.isError,
      true,
    );
    assert.equal(JSON.stringify(outcomes).includes('\\u0000'), false);
    assert.equal(JSON.stringify(harness.events).includes('\\u0000'), false);
  });

  it('rejects an array whose toJSON expands beyond the nested result limit', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const resultArray: unknown[] = [];
    Object.defineProperty(resultArray, 'toJSON', {
      value: () => 'x'.repeat(128),
    });

    const result = await harness.executeNested(
      tool(() => resultArray),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(JSON.stringify(outcomes).includes('x'.repeat(128)), false);
    assert.equal(JSON.stringify(harness.events).includes('x'.repeat(128)), false);
  });

  it('rejects a non-JSON nested result before coercion can expand it', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const callable = () => null;
    callable.toString = () => 'NON_JSON_RESULT'.repeat(32);

    const result = await harness.executeNested(
      tool(() => callable),
      32,
    );

    assert.equal((result as { error?: unknown }).error, 'Tool result byte limit exceeded');
    assert.equal(JSON.stringify(outcomes).includes('NON_JSON_RESULT'), false);
    assert.equal(JSON.stringify(harness.events).includes('NON_JSON_RESULT'), false);
  });

  it('admits a nested tool that returned nothing under the result limit', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    const result = await harness.executeNested(
      tool(() => undefined),
      32,
    );

    // An absent result is published as empty text, so it must not be rejected
    // as though the result were too large.
    assert.equal(result, undefined);
    assert.equal(JSON.stringify(outcomes).includes('byte limit exceeded'), false);
  });

  it('persists nested CodeMode identity across durable and legacy tool activity', async () => {
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async (input) => {
        prepared.push(input);
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    await harness.executeNested(tool(() => ({ ok: true })));

    for (const event of [
      prepared[0]?.runtimeEvent,
      prepared[0]?.dispatchRuntimeEvent,
      outcomes[0]?.runtimeEvent,
    ]) {
      assert.equal(event?.origin, 'code_mode');
      assert.equal(event?.modelVisibility, 'hidden');
      assert.equal(event?.refs?.parentToolCallId, 'exec-1');
      assert.equal(event?.refs?.parentOperationId, 'exec-op-1');
    }
    for (const event of harness.events) {
      if (event.type !== 'tool_start' && event.type !== 'tool_result') continue;
      assert.equal(event.origin, 'code_mode');
      assert.equal(event.modelVisibility, 'hidden');
      assert.equal(event.parentToolCallId, 'exec-1');
      assert.equal(event.parentOperationId, 'exec-op-1');
    }
    for (const message of harness.messages) {
      if (message.type !== 'tool_call' && message.type !== 'tool_result') continue;
      assert.equal(message.origin, 'code_mode');
      assert.equal(message.modelVisibility, 'hidden');
      assert.equal(message.parentToolCallId, 'exec-1');
      assert.equal(message.parentOperationId, 'exec-op-1');
    }
  });

  it('links nested live output to the outer exec activity', async () => {
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    });

    await harness.executeNested(
      tool((_input, context) => {
        context.emitOutput('stdout', 'working\n');
        return { ok: true };
      }),
    );

    const output = harness.events.find((event) => event.type === 'tool_output_delta');
    assert.ok(output);
    assert.equal(output.origin, 'code_mode');
    assert.equal(output.modelVisibility, 'hidden');
    assert.equal(output.parentToolCallId, 'exec-1');
    assert.equal(output.parentOperationId, 'exec-op-1');
  });

  it('retains nested identity when the tool settles with an error', async () => {
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    });

    await harness.executeNested(
      tool(() => {
        throw new Error('nested failure');
      }),
    );

    const result = harness.events.find(
      (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result' && event.toolUseId === 'nested-call-1',
    );
    assert.ok(result);
    assert.equal(result.isError, true);
    assert.equal(result.origin, 'code_mode');
    assert.equal(result.modelVisibility, 'hidden');
    assert.equal(result.parentToolCallId, 'exec-1');
    assert.equal(result.parentOperationId, 'exec-op-1');
    const stored = harness.messages.find(
      (message): message is Extract<StoredMessage, { type: 'tool_result' }> =>
        message.type === 'tool_result' && message.toolUseId === 'nested-call-1',
    );
    assert.equal(stored?.origin, 'code_mode');
    assert.equal(stored?.modelVisibility, 'hidden');
  });

  it('wraps business-domain kind values as canonical JSON tool results', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const output = {
      kind: 'plan_submitted',
      proposal: { proposalId: 'proposal-1' },
      storeVersion: 1,
    };

    assert.deepEqual(await harness.execute(tool(() => output)), output);
    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.deepEqual(response?.kind === 'function_response' ? response.result : undefined, {
      kind: 'json',
      value: output,
    });
    const message = harness.messages.find((candidate) => candidate.type === 'tool_result');
    assert.deepEqual(message?.type === 'tool_result' ? message.content : undefined, {
      kind: 'json',
      value: output,
    });
  });

  it('does not publish an implementation result when T2 fails', async () => {
    let implementationCalls = 0;
    const compensations: unknown[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('T2 unavailable');
      },
    });

    const target = tool(() => {
      implementationCalls += 1;
      return { ok: true };
    });
    target.compensateDurableOutcomeCommitFailure = async (input) => {
      compensations.push(input);
    };

    await assert.rejects(harness.execute(target), /T2 unavailable/);

    assert.equal(implementationCalls, 1);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
    assert.equal(compensations.length, 1);
    const compensation = compensations[0] as {
      result: unknown;
      isError: boolean;
      sessionId: string;
      operationId: string;
    };
    assert.deepEqual(
      { ...compensation, operationId: '<runtime-owned>' },
      {
        result: { kind: 'json', value: { ok: true } },
        isError: false,
        sessionId: 'session-1',
        operationId: '<runtime-owned>',
      },
    );
    assert.match(compensation.operationId, /^toolop_/);
  });

  it('keeps the T2 persistence error authoritative when compensation also fails', async () => {
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('T2 unavailable');
      },
    });
    const target = tool(() => ({ ok: true }));
    target.compensateDurableOutcomeCommitFailure = async () => {
      throw new Error('compensation unavailable');
    };

    await assert.rejects(harness.execute(target), /T2 unavailable/);
  });

  it('commits a normalized error outcome before returning a thrown tool failure to the model', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });

    await harness.execute(
      tool(() => {
        throw new Error('tool exploded');
      }),
    );

    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.equal(response?.kind === 'function_response' && response.isError, true);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result' && event.isError),
      true,
    );
  });

  it('commits outcome_unknown as a structured non-retryable tool failure', async () => {
    const outcomes: ToolOutcomeCommit[] = [];
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async (input) => {
        outcomes.push(input);
        return { created: true, runtimeEventSeq: 2 };
      },
    });
    const uncertain = tool(() => {
      throw new ToolOutcomeUnknownError('Provider disconnected after accepting the action');
    });
    uncertain.recoveryMode = 'never_auto_retry';

    const result = await harness.execute(uncertain);

    assert.deepEqual(result, {
      error: 'outcome_unknown: Provider disconnected after accepting the action',
    });
    const response = outcomes[0]?.runtimeEvent.content;
    assert.equal(response?.kind, 'function_response');
    assert.equal(response?.kind === 'function_response' && response.isError, true);
    assert.deepEqual(response?.kind === 'function_response' ? response.result : undefined, {
      kind: 'text',
      text: 'outcome_unknown: Provider disconnected after accepting the action',
      uncertainOutcome: {
        code: 'outcome_unknown',
        retrySafe: false,
      },
    });
    const message = harness.messages.find((candidate) => candidate.type === 'tool_result');
    assert.deepEqual(message?.type === 'tool_result' ? message.content : undefined, {
      kind: 'text',
      text: 'outcome_unknown: Provider disconnected after accepting the action',
      uncertainOutcome: {
        code: 'outcome_unknown',
        retrySafe: false,
      },
    });
  });
});

// `null` means the turn carries no run id at all; `undefined` keeps the default.
function makeHarness(
  sink: RuntimeCommitSink,
  order?: string[],
  runId: string | null = 'run-1',
  overrides: Partial<Parameters<typeof createTestToolRuntime>[0]> = {},
) {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: nextNow(),
    getPermissionPauseTarget: () => null,
    ...(runId ? { runId } : {}),
    runtimeCommitSink: sink,
    ...overrides,
  });
  return {
    messages,
    events,
    execute: async (target: MakaTool, abortSignal: AbortSignal = new AbortController().signal) =>
      (
        await runtime.settleToolCall({
          tool: target,
          turnId: 'turn-1',
          toolCallId: 'provider-call-1',
          input: {},
          abortSignal,
          eventSink: {
            push: (event) => {
              events.push(event);
              if (event.type === 'tool_result') order?.push('published-result');
            },
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
              if (event.type === 'tool_result') order?.push('published-result');
            },
          },
        })
      ).result,
    executeNested: async (target: MakaTool, maxResultBytes?: number) =>
      (
        await runtime.settleToolCall({
          tool: target,
          turnId: 'turn-1',
          toolCallId: 'nested-call-1',
          input: {},
          abortSignal: new AbortController().signal,
          eventSink: {
            push: (event) => events.push(event),
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
            },
          },
          origin: 'code_mode',
          parentToolCallId: 'exec-1',
          parentOperationId: 'exec-op-1',
          ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
        })
      ).result,
  };
}

function tool(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'Read',
    description: 'read',
    parameters: {},
    recoveryMode: 'replay_safe',
    impl,
  };
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
function nextNow(): () => number {
  let value = 0;
  return () => ++value;
}
