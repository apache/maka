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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  RuntimeCommitSink,
  ToolOutcomeCommit,
  ToolPreparedCommit,
} from '../runtime-commit-sink.js';
import {
  ToolRuntime,
  type MakaTool,
  type RuntimeManagedMutationAdmission,
  type ToolRuntimeInput,
} from '../tool-runtime.js';

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

  it('adopts an owner-committed managed successor without invoking generic T2', async () => {
    const order: string[] = [];
    const prepared: ToolPreparedCommit[] = [];
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          order.push('t1');
          return { created: true, runtimeEventSeq: 1 };
        },
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      order,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          order.push('admit');
          return managedAdmission(async (operation) => {
            order.push('lease-enter');
            const proof = await operation();
            order.push('successor-bundle');
            return {
              kind: 'workspace_successor_committed',
              durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                durationMs: proof.durationMs,
              }),
            };
          }, order);
        },
      },
    );
    const managedTool = tool(() => {
      throw new Error('ordinary mutable implementation must not run');
    });
    managedTool.managedMutationTransform = () => {
      order.push('transform');
      return { ok: true };
    };
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), { ok: true });
    assert.deepEqual(order, [
      'admit',
      't1',
      'lease-enter',
      'transform',
      'successor-bundle',
      'published-result',
      'dispose',
    ]);
    assert.deepEqual(
      prepared[0]?.dispatchRuntimeEvent.actions?.toolDispatch?.managedMutation,
      managedMutationDispatch(),
    );
  });

  it('does not replace a committed managed result when admission cleanup fails', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return {
            durableDispatch: managedMutationDispatch(),
            execute: async (operation) => {
              const proof = await operation();
              return {
                kind: 'workspace_successor_committed',
                durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                  durationMs: proof.durationMs,
                }),
              };
            },
            dispose: async () => {
              throw new Error('cleanup failed after commit');
            },
          };
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), { ok: true });
  });

  it('leaves a managed T1 unsettled without publishing or writing generic T2', async () => {
    let genericOutcomeCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            return { kind: 'unsettled', error: new Error('candidate state is unknown') };
          }),
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /candidate state is unknown/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops a thrown managed settlement instead of falling back to generic T2', async () => {
    let genericOutcomeCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            throw new Error('owner settlement channel failed');
          }),
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /owner settlement channel failed/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops a managed success with no durable outcome instead of writing generic T2', async () => {
    let genericOutcomeCalls = 0;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'workspace_successor_committed',
            } as never;
          }),
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /durable outcome/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('does not let a managed owner replace the Runtime-owned success result', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            const proof = await operation();
            const forgedContent = { kind: 'json' as const, value: { source: 'durable-B' } };
            return {
              kind: 'workspace_successor_committed',
              // Simulate an untyped/older Host attempting to reintroduce the
              // removed result channel. Runtime must ignore this value and
              // compare the durable event with its own captured operation.
              value: {
                result: { source: 'live-A' },
                outcome: {
                  content: forgedContent,
                  isError: false,
                  durationMs: proof.durationMs,
                },
              },
              durableOutcome: managedOutcomeEvent(operationId, forgedContent, false, {
                durationMs: proof.durationMs,
              }),
            } as never;
          });
        },
      },
    );
    const managedTool = tool(() => ({ source: 'runtime-original' }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /mismatched durable outcome/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('publishes one immutable snapshot when the tool mutates its returned object later', async () => {
    let operationId = '';
    const mutableResult = { state: 'A' };
    const appendedMessages: StoredMessage[] = [];
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        appendMessage: async (message) => {
          if (message.type === 'tool_result') mutableResult.state = 'B';
          appendedMessages.push(structuredClone(message));
        },
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            const proof = await operation();
            return {
              kind: 'workspace_successor_committed',
              durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                durationMs: proof.durationMs,
              }),
            };
          });
        },
      },
    );
    const managedTool = tool(() => mutableResult);
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    const result = await harness.execute(managedTool);
    const storedResult = appendedMessages.find((message) => message.type === 'tool_result');
    const liveEvent = harness.events.find((event) => event.type === 'tool_result');

    assert.equal(mutableResult.state, 'B');
    assert.deepEqual(result, { state: 'A' });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(storedResult?.type === 'tool_result' ? storedResult.content : undefined, {
      kind: 'json',
      value: { state: 'A' },
    });
    assert.deepEqual(liveEvent?.type === 'tool_result' ? liveEvent.content : undefined, {
      kind: 'json',
      value: { state: 'A' },
    });
  });

  it('preserves JSON __proto__ keys as immutable data properties', async () => {
    let operationId = '';
    const resultWithProtoKey = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(resultWithProtoKey, '__proto__', {
      enumerable: true,
      value: { safe: true },
    });
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            const proof = await operation();
            return {
              kind: 'workspace_successor_committed',
              durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                durationMs: proof.durationMs,
              }),
            };
          });
        },
      },
    );
    const managedTool = tool(() => resultWithProtoKey);
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    const result = (await harness.execute(managedTool)) as Record<string, unknown>;

    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.deepEqual(result.__proto__, { safe: true });
    assert.equal(Object.isFrozen(result.__proto__), true);
    assert.equal(JSON.stringify(result), '{"__proto__":{"safe":true}}');
  });

  it('adopts an owner-committed safe discard without invoking generic T2', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            const result = { error: 'candidate was safely discarded' };
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult: result,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: result },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), {
      error: 'candidate was safely discarded',
    });
    assert.equal(genericOutcomeCalls, 0);
    const published = harness.events.at(-1);
    assert.equal(published?.type, 'tool_result');
    assert.equal(published?.type === 'tool_result' && published.isError, true);
  });

  it('publishes an owner-committed no-change success without invoking generic T2', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            const result = { ok: true, changed: false };
            return {
              kind: 'no_workspace_change_committed',
              providerResult: result,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: result },
                false,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ignored: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), { ok: true, changed: false });
    const published = harness.events.at(-1);
    assert.equal(published?.type, 'tool_result');
    assert.equal(published?.type === 'tool_result' && published.isError, false);
  });

  it('snapshots a safe-discard result before its owner can mutate it', async () => {
    let operationId = '';
    const ownerResult = { error: 'discarded-A' };
    const appendedMessages: StoredMessage[] = [];
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        appendMessage: async (message) => {
          if (message.type === 'tool_result') ownerResult.error = 'mutated-B';
          appendedMessages.push(structuredClone(message));
        },
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult: ownerResult,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: { error: 'discarded-A' } },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    const result = await harness.execute(managedTool);
    const storedResult = appendedMessages.find((message) => message.type === 'tool_result');

    assert.equal(ownerResult.error, 'mutated-B');
    assert.deepEqual(result, { error: 'discarded-A' });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(storedResult?.type === 'tool_result' ? storedResult.content : undefined, {
      kind: 'json',
      value: { error: 'discarded-A' },
    });
  });

  it('revokes a retained managed operation after terminal settlement', async () => {
    let operationId = '';
    let implementationCalls = 0;
    let retainedOperation: Parameters<RuntimeManagedMutationAdmission['execute']>[0] | undefined;
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            retainedOperation = operation;
            const result = { error: 'candidate was safely discarded' };
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult: result,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: result },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => {
      implementationCalls += 1;
      return { ok: true };
    });
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), {
      error: 'candidate was safely discarded',
    });
    assert.ok(retainedOperation);
    await assert.rejects(retainedOperation(), /operation capability is closed/i);
    assert.equal(implementationCalls, 0);
  });

  it('does not accept terminal settlement while a detached operation is running', async () => {
    let operationId = '';
    let releaseOperation!: () => void;
    const operationBlocked = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            void operation().catch(() => undefined);
            const result = { error: 'candidate was safely discarded' };
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult: result,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: result },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(async () => {
      await operationBlocked;
      return { ok: true };
    });
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    const execution = harness.execute(managedTool);
    const settledBeforeRelease = await Promise.race([
      execution.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    releaseOperation();

    assert.equal(settledBeforeRelease, false);
    await assert.rejects(execution, /owner settled before the operation completed/i);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('rejects a safe discard whose live error differs from its durable result', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult: { error: 'live provider error A' },
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: { error: 'durable replay error B' } },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /mismatched durable outcome/i);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops safe-discard canonicalization without writing generic T2', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const providerResult = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => {
        throw new Error('provider result getter exploded');
      },
    });
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: { error: 'discarded' } },
                true,
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(
      harness.execute(managedTool),
      /strict JSON.*accessor|provider result getter exploded|byte limit exceeded/i,
    );
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('fail-stops an oversized safe discard before durable publication', async () => {
    let genericOutcomeCalls = 0;
    let operationId = '';
    const oversized = { error: 'x'.repeat(128) };
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            await operation();
            return {
              kind: 'operation_failed_no_effect_committed',
              providerResult: oversized,
              durableOutcome: managedOutcomeEvent(
                operationId,
                { kind: 'json', value: oversized },
                true,
                {
                  origin: 'code_mode',
                  modelVisibility: 'hidden',
                  toolCallId: 'nested-call-1',
                  parentToolCallId: 'exec-1',
                  parentOperationId: 'exec-op-1',
                },
              ),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.executeNested(managedTool, 32), /byte limit exceeded/i);
    assert.equal(genericOutcomeCalls, 0);
    assert.equal(JSON.stringify(harness.events).includes(oversized.error), false);
  });

  it('stops snapshot traversal as soon as a managed result exceeds its byte budget', async () => {
    let genericOutcomeCalls = 0;
    let lateGetterReads = 0;
    const oversizedResult = { payload: 'x'.repeat(128) } as Record<string, unknown>;
    Object.defineProperty(oversizedResult, 'mustNotBeRead', {
      enumerable: true,
      get: () => {
        lateGetterReads += 1;
        throw new Error('snapshot walked past its byte budget');
      },
    });
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          genericOutcomeCalls += 1;
          return { created: true, runtimeEventSeq: 2 };
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            return { kind: 'unsettled', error: new Error('unreachable') };
          }),
      },
    );
    const managedTool = tool(() => oversizedResult);
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(
      harness.executeNested(managedTool, 32),
      /tool result byte limit exceeded/i,
    );
    assert.equal(lateGetterReads, 0);
    assert.equal(genericOutcomeCalls, 0);
  });

  it('enforces the fixed managed result budget when the caller omits one', async () => {
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            return { kind: 'unsettled', error: new Error('unreachable') };
          }),
      },
    );
    const managedTool = tool(() => ({ payload: 'x'.repeat(1024 * 1024 + 1) }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /tool result byte limit exceeded/i);
  });

  it('rejects a managed result deeper than the fixed profile permits', async () => {
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async () =>
          managedAdmission(async (operation) => {
            await operation();
            return { kind: 'unsettled', error: new Error('unreachable') };
          }),
      },
    );
    let result: Record<string, unknown> = {};
    for (let depth = 0; depth < 66; depth += 1) result = { child: result };
    const managedTool = tool(() => result);
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /tool result byte limit exceeded/i);
  });

  it('rejects undefined fields instead of creating a non-canonical durable result', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            const proof = await operation();
            return {
              kind: 'workspace_successor_committed',
              durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                durationMs: proof.durationMs,
              }),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true, missing: undefined }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.execute(managedTool), /strict JSON.*undefined/i);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  for (const [description, makeResult, expectedError] of [
    ['non-finite numbers', () => ({ n: Number.NaN }), /strict JSON.*not finite/i],
    ['undefined array entries', () => ({ list: [undefined] }), /strict JSON.*undefined/i],
    ['sparse arrays', () => ({ list: new Array<unknown>(1) }), /strict JSON.*sparse array/i],
  ] as const) {
    it(`rejects ${description} before accepting a managed durable result`, async () => {
      let operationId = '';
      const harness = makeHarness(
        {
          commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
          commitToolOutcome: async () => {
            throw new Error('generic T2 must not settle a managed mutation');
          },
        },
        undefined,
        'run-1',
        {
          admitManagedMutation: async (input) => {
            operationId = input.operationId;
            return managedAdmission(async (operation) => {
              const proof = await operation();
              return {
                kind: 'workspace_successor_committed',
                durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                  durationMs: proof.durationMs,
                }),
              };
            });
          },
        },
      );
      const managedTool = tool(() => makeResult());
      managedTool.name = 'Write';
      managedTool.recoveryMode = 'reconcile';
      managedTool.durableExecutionProfile = 'managed_mutation_v1';

      await assert.rejects(harness.execute(managedTool), expectedError);
      assert.equal(
        harness.events.some((event) => event.type === 'tool_result'),
        false,
      );
    });
  }

  it('rejects a durable managed response with a different code-mode envelope', async () => {
    let operationId = '';
    const harness = makeHarness(
      {
        commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
        commitToolOutcome: async () => {
          throw new Error('generic T2 must not settle a managed mutation');
        },
      },
      undefined,
      'run-1',
      {
        admitManagedMutation: async (input) => {
          operationId = input.operationId;
          return managedAdmission(async (operation) => {
            const proof = await operation();
            return {
              kind: 'workspace_successor_committed',
              durableOutcome: managedOutcomeEvent(operationId, proof.content, false, {
                durationMs: proof.durationMs,
                origin: 'code_mode',
                // The live nested call is hidden. A visible durable replay is
                // a different provider contract and must never be adopted.
                modelVisibility: 'visible',
                toolCallId: 'nested-call-1',
                parentToolCallId: 'exec-1',
                parentOperationId: 'exec-op-1',
              }),
            };
          });
        },
      },
    );
    const managedTool = tool(() => ({ ok: true }));
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    await assert.rejects(harness.executeNested(managedTool), /mismatched durable outcome/i);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
  });

  it('refuses a managed mutation before T1 when host admission is unavailable', async () => {
    let preparedCalls = 0;
    let implementationCalls = 0;
    const harness = makeHarness({
      commitToolPrepared: async () => {
        preparedCalls += 1;
        return { created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => ({ created: true, runtimeEventSeq: 2 }),
    });
    const managedTool = tool(() => {
      implementationCalls += 1;
      return { ok: true };
    });
    managedTool.name = 'Write';
    managedTool.recoveryMode = 'reconcile';
    managedTool.durableExecutionProfile = 'managed_mutation_v1';

    assert.deepEqual(await harness.execute(managedTool), {
      error: 'Managed workspace mutation admission is unavailable before T1',
    });
    assert.equal(preparedCalls, 0);
    assert.equal(implementationCalls, 0);
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
    const harness = makeHarness({
      commitToolPrepared: async () => ({ created: true, runtimeEventSeq: 1 }),
      commitToolOutcome: async () => {
        throw new Error('T2 unavailable');
      },
    });

    await assert.rejects(
      harness.execute(
        tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
      ),
      /T2 unavailable/,
    );

    assert.equal(implementationCalls, 1);
    assert.equal(
      harness.events.some((event) => event.type === 'tool_result'),
      false,
    );
    assert.equal(
      harness.messages.some((message) => message.type === 'tool_result'),
      false,
    );
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
  overrides: Partial<ToolRuntimeInput> = {},
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
          input: target.durableExecutionProfile ? { path: 'notes.txt' } : {},
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
          input: target.durableExecutionProfile ? { path: 'notes.txt' } : {},
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

function managedAdmission(
  execute: RuntimeManagedMutationAdmission['execute'],
  order?: string[],
): RuntimeManagedMutationAdmission {
  return {
    durableDispatch: managedMutationDispatch(),
    execute,
    dispose: async () => {
      order?.push('dispose');
    },
  };
}

function managedOutcomeEvent(
  operationId: string,
  result: unknown,
  isError: boolean,
  options: {
    durationMs?: number;
    modelProjection?: NonNullable<
      Extract<RuntimeEvent['content'], { kind: 'function_response' }>['modelProjection']
    >;
    origin?: 'provider' | 'code_mode';
    modelVisibility?: 'visible' | 'hidden';
    toolCallId?: string;
    parentToolCallId?: string;
    parentOperationId?: string;
  } = {},
) {
  const toolCallId = options.toolCallId ?? 'provider-call-1';
  return {
    id: `${operationId}_response`,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'tool' as const,
    author: 'tool' as const,
    origin: options.origin ?? ('provider' as const),
    modelVisibility: options.modelVisibility ?? ('visible' as const),
    content: {
      kind: 'function_response' as const,
      id: toolCallId,
      name: 'Write',
      result,
      ...(isError ? { isError: true } : {}),
      modelProjection: options.modelProjection ?? managedModelProjection(result),
    },
    refs: {
      operationId,
      toolCallId,
      ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
      ...(options.parentOperationId ? { parentOperationId: options.parentOperationId } : {}),
    },
    actions: { stateDelta: { durationMs: options.durationMs ?? 0 } },
  };
}

function managedModelProjection(
  result: unknown,
): NonNullable<Extract<RuntimeEvent['content'], { kind: 'function_response' }>['modelProjection']> {
  const raw =
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { kind?: unknown }).kind === 'json'
      ? (result as { value: unknown }).value
      : result;
  const providerError =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { error?: unknown }).error
      : undefined;
  if (typeof providerError === 'string') {
    return { version: 1, kind: 'text', text: `Error: ${providerError}`, isError: true };
  }
  return { version: 1, kind: 'json', value: raw as never };
}

function managedMutationDispatch() {
  return {
    protocol: 'managed_mutation_v2' as const,
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    objectFormat: 'sha1' as const,
    baseWorkspaceVersionId: 'version_55555555555555555555555555555555',
    baseAcceptedEventId: 'baseline-event-1',
    baseHeadRevision: 1,
    baseCommitOid: '1'.repeat(40),
    baseTreeOid: '2'.repeat(40),
    expectedPath: 'notes.txt',
    pathPolicyVersion: 3 as const,
    executionProfileDigest:
      'sha256:ffdfdda9cf38f382e0c4db81dac7319cd33586a6c65051a97a15e6c41b88f825' as const,
  };
}

function tool(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'Read',
    description: 'read',
    parameters: {},
    recoveryMode: 'replay_safe',
    impl,
    managedMutationTransform: (args) => impl(args, undefined as never),
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
