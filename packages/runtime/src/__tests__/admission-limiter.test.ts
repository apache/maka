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
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import { AdmissionLimiter } from '../admission-limiter.js';
import {
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  ToolRuntime,
  type MakaTool,
  type MakaToolContext,
} from '../tool-runtime.js';

describe('AdmissionLimiter', () => {
  test('grants waiting permits in FIFO order and makes release idempotent', async () => {
    const limiter = new AdmissionLimiter(1);
    const first = await limiter.acquire(new AbortController().signal);
    const grants: string[] = [];
    const secondPending = limiter.acquire(new AbortController().signal).then((permit) => {
      grants.push('second');
      return permit;
    });
    const thirdPending = limiter.acquire(new AbortController().signal).then((permit) => {
      grants.push('third');
      return permit;
    });

    assert.equal(limiter.activeCount, 1);
    assert.equal(limiter.waitingCount, 2);
    first.release();
    first.release();

    const second = await secondPending;
    assert.deepEqual(grants, ['second']);
    assert.equal(limiter.activeCount, 1);
    assert.equal(limiter.waitingCount, 1);

    second.release();
    const third = await thirdPending;
    assert.deepEqual(grants, ['second', 'third']);
    third.release();
    assert.equal(limiter.activeCount, 0);
    assert.equal(limiter.waitingCount, 0);
  });

  test('removes an aborted waiter without consuming capacity', async () => {
    const limiter = new AdmissionLimiter(1);
    const first = await limiter.acquire(new AbortController().signal);
    const waitingController = new AbortController();
    const waiting = limiter.acquire(waitingController.signal);

    waitingController.abort(new Error('stop queued child'));

    await assert.rejects(waiting, /stop queued child/);
    assert.equal(limiter.activeCount, 1);
    assert.equal(limiter.waitingCount, 0);
    first.release();
    assert.equal(limiter.activeCount, 0);
  });

  test('closes the turn scope for queued and future permits', async () => {
    const limiter = new AdmissionLimiter(1);
    const first = await limiter.acquire(new AbortController().signal);
    const second = limiter.acquire(new AbortController().signal);
    const third = limiter.acquire(new AbortController().signal);

    limiter.close(new Error('turn scope ended'));

    await assert.rejects(second, /turn scope ended/);
    await assert.rejects(third, /turn scope ended/);
    await assert.rejects(limiter.acquire(new AbortController().signal), /turn scope ended/);
    assert.equal(limiter.waitingCount, 0);
    first.release();
  });
});

describe('ToolRuntime child-agent run permits', () => {
  test('caps real child runs spawned inside one admitted subagent tool', async () => {
    const active = new Set<string>();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let maxActive = 0;
    const runtime = buildRuntime(async (input) => {
      const prompt = input.prompt;
      started.push(prompt);
      active.add(prompt);
      maxActive = Math.max(maxActive, active.size);
      return await new Promise((resolve) => {
        let released = false;
        releases.set(prompt, () => {
          if (released) return;
          released = true;
          active.delete(prompt);
          resolve({ prompt });
        });
      });
    });
    const tool = childBatchProbeTool(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN + 1);
    const pending = executeTool(runtime, tool, new AbortController());

    await waitFor(() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(active.size, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(releases.has(`child-${MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN}`), false);

    releases.get('child-0')?.();
    await waitFor(() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN + 1);
    assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

    for (const release of releases.values()) release();
    await pending;
    assert.equal(active.size, 0);
  });

  test('does not start a queued child after the parent tool is aborted', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const runtime = buildRuntime(async (input) => {
      started.push(input.prompt);
      return await new Promise((resolve) => {
        releases.push(() => resolve({ prompt: input.prompt }));
      });
    });
    const controller = new AbortController();
    const pending = executeTool(
      runtime,
      childBatchProbeTool(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN + 1, true),
      controller,
    );
    await waitFor(() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

    controller.abort(new Error('parent tool aborted'));
    for (const release of releases) release();
    const result = (await pending) as { kind?: string; value?: { rejected?: number } };

    assert.equal(started.length, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(result.kind, 'json');
    assert.equal(result.value?.rejected, 1);
  });

  test('shares one child-run pool across concurrently admitted tools', async () => {
    const active = new Set<string>();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let maxActive = 0;
    const runtime = buildRuntime(async (input) => {
      const prompt = input.prompt;
      started.push(prompt);
      active.add(prompt);
      maxActive = Math.max(maxActive, active.size);
      return await new Promise((resolve) => {
        let released = false;
        releases.set(prompt, () => {
          if (released) return;
          released = true;
          active.delete(prompt);
          resolve({ prompt });
        });
      });
    });
    const firstCount = Math.floor(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN / 2);
    const secondCount = MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN - firstCount + 1;
    const first = executeTool(
      runtime,
      childBatchProbeTool(firstCount, false, 'first_batch_probe', 'first'),
      new AbortController(),
    );
    const second = executeTool(
      runtime,
      childBatchProbeTool(secondCount, false, 'second_batch_probe', 'second'),
      new AbortController(),
    );

    await waitFor(() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(active.size, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

    releases.get(started[0]!)?.();
    await waitFor(() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN + 1);
    assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

    for (const release of releases.values()) release();
    await Promise.all([first, second]);
    assert.equal(active.size, 0);
  });

  test('releases the permit when child startup throws', async () => {
    let started = 0;
    const runtime = buildRuntime(async () => {
      started += 1;
      throw new Error('child startup failed');
    });
    const attempts = MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN * 2;
    const result = (await withTimeout(
      executeTool(runtime, sequentialFailureProbeTool(attempts), new AbortController()),
      1_000,
      'permit leak stalled sequential child starts',
    )) as { kind?: string; value?: { rejected?: number } };

    assert.equal(started, attempts);
    assert.equal(result.kind, 'json');
    assert.equal(result.value?.rejected, attempts);
  });

  test('rejects future child starts from a tool context after its turn ends', async () => {
    let childStarts = 0;
    let capturedSpawn: MakaToolContext['spawnChildAgent'];
    const runtime = buildRuntime(async () => {
      childStarts += 1;
      return {};
    });
    const tool: MakaTool = {
      name: 'capture_child_spawn',
      description: 'test-only spawn capability capture',
      parameters: {},
      impl: async (_args, ctx) => {
        capturedSpawn = ctx.spawnChildAgent;
        return { kind: 'json', value: { captured: true } };
      },
    };
    await executeTool(runtime, tool, new AbortController());
    runtime.endTurn();

    assert.ok(capturedSpawn);
    await assert.rejects(
      capturedSpawn({
        spec: childSpec(0),
        prompt: 'late child',
      }),
      /permit scope ended/,
    );
    assert.equal(childStarts, 0);
  });
});

function childBatchProbeTool(
  count: number,
  summarizeSettled = false,
  name = 'child_batch_probe',
  promptPrefix = 'child',
): MakaTool {
  return {
    name,
    description: 'test-only child batch probe',
    parameters: {},
    categoryHint: 'subagent',
    impl: async (_args, ctx) => {
      if (!ctx.spawnChildAgent) throw new Error('missing spawn capability');
      const pending = Array.from({ length: count }, (_, index) =>
        ctx.spawnChildAgent!({
          spec: childSpec(index),
          prompt: `${promptPrefix}-${index}`,
        }),
      );
      if (!summarizeSettled) return { kind: 'json', value: await Promise.all(pending) };
      const settled = await Promise.allSettled(pending);
      return {
        kind: 'json',
        value: {
          fulfilled: settled.filter((result) => result.status === 'fulfilled').length,
          rejected: settled.filter((result) => result.status === 'rejected').length,
        },
      };
    },
  };
}

function sequentialFailureProbeTool(count: number): MakaTool {
  return {
    name: 'sequential_child_failure_probe',
    description: 'test-only sequential child failure probe',
    parameters: {},
    categoryHint: 'subagent',
    impl: async (_args, ctx) => {
      if (!ctx.spawnChildAgent) throw new Error('missing spawn capability');
      let rejected = 0;
      for (let index = 0; index < count; index += 1) {
        try {
          await ctx.spawnChildAgent({
            spec: childSpec(index),
            prompt: `failure-${index}`,
          });
        } catch {
          rejected += 1;
        }
      }
      return { kind: 'json', value: { rejected } };
    },
  };
}

function childSpec(index: number) {
  return {
    id: `test-child-${index}`,
    name: `Test Child ${index}`,
    systemPrompt: 'Test child.',
  };
}

function buildRuntime(
  spawnChildAgent: NonNullable<ConstructorParameters<typeof ToolRuntime>[0]['spawnChildAgent']>,
): ToolRuntime {
  return createTestToolRuntime({
    sessionId: 'session-1',
    header: testHeader(),
    connection: testConnection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    runId: 'parent-run',
    spawnChildAgent,
  });
}

async function executeTool(
  runtime: ToolRuntime,
  tool: MakaTool,
  controller: AbortController,
): Promise<unknown> {
  return (
    await runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: `tool-${tool.name}`,
      input: {},
      abortSignal: controller.signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    })
  ).result;
}

function testHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp',
    cwd: '/tmp',
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
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'explore',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
