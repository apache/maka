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
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';

import { buildBuiltinToolComposition } from '../builtin-tools.js';
import type { FilesystemWorkerExecuteInput } from '../filesystem-worker/client.js';
import type { FilesystemWorkerResult } from '../filesystem-worker/protocol.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import type { ResourceClaim } from '../preparation/types.js';
import { settleToolCallBatch } from '../tool-call-batch.js';
import type { MakaToolContext } from '../tool-runtime.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('filesystem ToolCallBatch scenarios', () => {
  test('independent batches: Read holds a same-file Edit until the first batch settles', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const readCalls: ScenarioCall[] = [
      { id: 'read-a', toolName: 'Read', input: { path: 'a.txt' } },
    ];
    const editCalls: ScenarioCall[] = [
      {
        id: 'edit-a',
        toolName: 'Edit',
        input: { path: 'a.txt', old_string: 'before', new_string: 'after' },
      },
    ];
    const readBatch = startBatch(cwd, observer, readCalls);
    let editBatch: ReturnType<typeof startBatch> | undefined;
    let readOutcomes: Awaited<typeof readBatch.outcomes> | undefined;
    let editOutcomes: Awaited<ReturnType<typeof startBatch>['outcomes']> | undefined;

    try {
      await observer.waitForStarted(['read:a.txt#1']);
      editBatch = startBatch(cwd, observer, editCalls);
      await Promise.resolve();
      await Promise.resolve();
      observer.assertActive(['read:a.txt#1']);
      assert.deepEqual(observer.started, ['read:a.txt#1']);

      observer.release('read:a.txt#1');
      await observer.waitForStarted(['edit:a.txt#1']);
      observer.assertActive(['edit:a.txt#1']);
    } finally {
      observer.releaseAll();
      [readOutcomes, editOutcomes] = await Promise.all([
        readBatch.outcomes,
        editBatch?.outcomes ?? Promise.resolve([]),
      ]);
    }

    assert.equal(observer.maxActive, 1);
    assertFulfilledInModelOrder(readOutcomes, readCalls);
    assertFulfilledInModelOrder(editOutcomes, editCalls);
  });

  test('independent batches: Grep tree lease holds an in-tree Write', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const grepCalls: ScenarioCall[] = [
      { id: 'grep-src', toolName: 'Grep', input: { pattern: 'needle', path: 'src' } },
    ];
    const writeCalls: ScenarioCall[] = [
      {
        id: 'write-src-a',
        toolName: 'Write',
        input: { path: 'src/a.ts', content: 'export const a = 1;' },
      },
    ];
    const grepBatch = startBatch(cwd, observer, grepCalls);
    let writeBatch: ReturnType<typeof startBatch> | undefined;
    let grepOutcomes: Awaited<typeof grepBatch.outcomes> | undefined;
    let writeOutcomes: Awaited<ReturnType<typeof startBatch>['outcomes']> | undefined;

    try {
      await observer.waitForStarted(['grep:src#1']);
      writeBatch = startBatch(cwd, observer, writeCalls);
      await Promise.resolve();
      await Promise.resolve();
      observer.assertActive(['grep:src#1']);
      assert.deepEqual(observer.started, ['grep:src#1']);

      observer.release('grep:src#1');
      await observer.waitForStarted(['write:src/a.ts#1']);
      observer.assertActive(['write:src/a.ts#1']);
    } finally {
      observer.releaseAll();
      [grepOutcomes, writeOutcomes] = await Promise.all([
        grepBatch.outcomes,
        writeBatch?.outcomes ?? Promise.resolve([]),
      ]);
    }

    assert.equal(observer.maxActive, 1);
    assertFulfilledInModelOrder(grepOutcomes, grepCalls);
    assertFulfilledInModelOrder(writeOutcomes, writeCalls);
  });

  test('2 calls: same-file read then write serialize', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const calls: ScenarioCall[] = [
      { id: 'read-a', toolName: 'Read', input: { path: 'a.txt' } },
      { id: 'write-a', toolName: 'Write', input: { path: 'a.txt', content: 'A' } },
    ];
    const run = startBatch(cwd, observer, calls);

    let outcomes: Awaited<typeof run.outcomes> | undefined;
    try {
      await observer.waitForStarted(['read:a.txt#1']);
      observer.assertActive(['read:a.txt#1']);
      assert.deepEqual(observer.started, ['read:a.txt#1']);

      observer.release('read:a.txt#1');
      await observer.waitForStarted(['write:a.txt#1']);
      observer.assertActive(['write:a.txt#1']);
      assert.deepEqual(observer.started, ['read:a.txt#1', 'write:a.txt#1']);
    } finally {
      observer.releaseAll();
      outcomes = await run.outcomes;
    }

    assert.equal(observer.maxActive, 1);
    assertClaims(run.claims, cwd, {
      'read-a': ['filesystem:workspace|read|exact|a.txt'],
      'write-a': ['filesystem:workspace|write|exact|a.txt'],
    });
    assertFulfilledInModelOrder(outcomes, calls);
  });

  test('2 calls: same-file reads start together', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const calls: ScenarioCall[] = [
      { id: 'read-a-1', toolName: 'Read', input: { path: 'a.txt' } },
      { id: 'read-a-2', toolName: 'Read', input: { path: 'a.txt' } },
    ];
    const run = startBatch(cwd, observer, calls);

    let outcomes: Awaited<typeof run.outcomes> | undefined;
    try {
      await observer.waitForStarted(['read:a.txt#1', 'read:a.txt#2']);
      observer.assertActive(['read:a.txt#1', 'read:a.txt#2']);
      observer.assertStarted(['read:a.txt#1', 'read:a.txt#2']);
    } finally {
      observer.releaseAll();
      outcomes = await run.outcomes;
    }

    assert.equal(observer.maxActive, 2);
    assertClaims(run.claims, cwd, {
      'read-a-1': ['filesystem:workspace|read|exact|a.txt'],
      'read-a-2': ['filesystem:workspace|read|exact|a.txt'],
    });
    assertFulfilledInModelOrder(outcomes, calls);
  });

  test('3 calls: queued writer prevents a later reader from bypassing it', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const calls: ScenarioCall[] = [
      { id: 'read-a-1', toolName: 'Read', input: { path: 'a.txt' } },
      { id: 'write-a', toolName: 'Write', input: { path: 'a.txt', content: 'A' } },
      { id: 'read-a-2', toolName: 'Read', input: { path: 'a.txt' } },
    ];
    const run = startBatch(cwd, observer, calls);

    let outcomes: Awaited<typeof run.outcomes> | undefined;
    try {
      await observer.waitForStarted(['read:a.txt#1']);
      observer.assertActive(['read:a.txt#1']);
      assert.deepEqual(observer.started, ['read:a.txt#1']);

      observer.release('read:a.txt#1');
      await observer.waitForStarted(['write:a.txt#1']);
      observer.assertActive(['write:a.txt#1']);
      assert.deepEqual(observer.started, ['read:a.txt#1', 'write:a.txt#1']);

      observer.release('write:a.txt#1');
      await observer.waitForStarted(['read:a.txt#2']);
      observer.assertActive(['read:a.txt#2']);
      assert.deepEqual(observer.started, ['read:a.txt#1', 'write:a.txt#1', 'read:a.txt#2']);
    } finally {
      observer.releaseAll();
      outcomes = await run.outcomes;
    }

    assert.equal(observer.maxActive, 1);
    assertClaims(run.claims, cwd, {
      'read-a-1': ['filesystem:workspace|read|exact|a.txt'],
      'write-a': ['filesystem:workspace|write|exact|a.txt'],
      'read-a-2': ['filesystem:workspace|read|exact|a.txt'],
    });
    assertFulfilledInModelOrder(outcomes, calls);
  });

  test('4 calls: tree read blocks only the in-tree writer', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const calls: ScenarioCall[] = [
      { id: 'grep-src', toolName: 'Grep', input: { pattern: 'needle', path: 'src' } },
      {
        id: 'write-src-a',
        toolName: 'Write',
        input: { path: 'src/a.ts', content: 'export const a = 1;' },
      },
      {
        id: 'write-other-b',
        toolName: 'Write',
        input: { path: 'other/b.ts', content: 'export const b = 2;' },
      },
      { id: 'read-src-c', toolName: 'Read', input: { path: 'src/c.ts' } },
    ];
    const run = startBatch(cwd, observer, calls);

    let outcomes: Awaited<typeof run.outcomes> | undefined;
    try {
      await observer.waitForStarted(['grep:src#1', 'write:other/b.ts#1', 'read:src/c.ts#1']);
      observer.assertActive(['grep:src#1', 'write:other/b.ts#1', 'read:src/c.ts#1']);
      observer.assertStarted(['grep:src#1', 'write:other/b.ts#1', 'read:src/c.ts#1']);

      observer.release('grep:src#1');
      await observer.waitForStarted(['write:src/a.ts#1']);
      observer.assertActive(['write:other/b.ts#1', 'read:src/c.ts#1', 'write:src/a.ts#1']);
      observer.assertStarted([
        'grep:src#1',
        'write:other/b.ts#1',
        'read:src/c.ts#1',
        'write:src/a.ts#1',
      ]);
    } finally {
      observer.releaseAll();
      outcomes = await run.outcomes;
    }

    assert.equal(observer.maxActive, 3);
    assertClaims(run.claims, cwd, {
      'grep-src': ['filesystem:workspace|read|tree|src'],
      'write-src-a': ['filesystem:workspace|write|exact|src/a.ts'],
      'write-other-b': ['filesystem:workspace|write|exact|other/b.ts'],
      'read-src-c': ['filesystem:workspace|read|exact|src/c.ts'],
    });
    assertFulfilledInModelOrder(outcomes, calls);
  });

  test('5 calls: tree conflict, writer fairness, and src/src2 boundary compose', async () => {
    const cwd = await scenarioWorkspace();
    const observer = new ControlledFilesystemWorker();
    const calls: ScenarioCall[] = [
      { id: 'grep-src', toolName: 'Grep', input: { pattern: 'needle', path: 'src' } },
      {
        id: 'write-src-a',
        toolName: 'Write',
        input: { path: 'src/a.ts', content: 'export const a = 1;' },
      },
      { id: 'read-src-a', toolName: 'Read', input: { path: 'src/a.ts' } },
      {
        id: 'write-src2-a',
        toolName: 'Write',
        input: { path: 'src2/a.ts', content: 'export const sibling = true;' },
      },
      { id: 'glob-src', toolName: 'Glob', input: { pattern: '**/*.ts', cwd: 'src' } },
    ];
    const run = startBatch(cwd, observer, calls);

    let outcomes: Awaited<typeof run.outcomes> | undefined;
    try {
      await observer.waitForStarted(['grep:src#1', 'write:src2/a.ts#1']);
      observer.assertActive(['grep:src#1', 'write:src2/a.ts#1']);
      observer.assertStarted(['grep:src#1', 'write:src2/a.ts#1']);

      observer.release('grep:src#1');
      await observer.waitForStarted(['write:src/a.ts#1']);
      observer.assertActive(['write:src2/a.ts#1', 'write:src/a.ts#1']);
      observer.assertStarted(['grep:src#1', 'write:src2/a.ts#1', 'write:src/a.ts#1']);

      observer.release('write:src/a.ts#1');
      await observer.waitForStarted(['read:src/a.ts#1', 'glob:src#1']);
      observer.assertActive(['write:src2/a.ts#1', 'read:src/a.ts#1', 'glob:src#1']);
      observer.assertStarted([
        'grep:src#1',
        'write:src2/a.ts#1',
        'write:src/a.ts#1',
        'read:src/a.ts#1',
        'glob:src#1',
      ]);
    } finally {
      observer.releaseAll();
      outcomes = await run.outcomes;
    }

    assert.equal(observer.maxActive, 3);
    assertClaims(run.claims, cwd, {
      'grep-src': ['filesystem:workspace|read|tree|src'],
      'write-src-a': ['filesystem:workspace|write|exact|src/a.ts'],
      'read-src-a': ['filesystem:workspace|read|exact|src/a.ts'],
      'write-src2-a': ['filesystem:workspace|write|exact|src2/a.ts'],
      'glob-src': ['filesystem:workspace|read|tree|src'],
    });
    assertFulfilledInModelOrder(outcomes, calls);
  });
});

interface ScenarioCall {
  readonly id: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface ScenarioValue {
  readonly id: string;
  readonly output: unknown;
}

function startBatch(
  cwd: string,
  observer: ControlledFilesystemWorker,
  calls: readonly ScenarioCall[],
): {
  readonly claims: Map<string, readonly ResourceClaim[]>;
  readonly outcomes: Promise<PromiseSettledResult<ScenarioValue>[]>;
} {
  const composition = buildBuiltinToolComposition({
    filesystemWorker: { execute: (input) => observer.execute(input) },
  });
  const preparation = new ToolPreparationService(composition.authorityRegistry);
  const tools = new Map(composition.tools.map((tool) => [tool.name, tool]));
  const claims = new Map<string, readonly ResourceClaim[]>();
  const abortSignal = new AbortController().signal;
  const executionBoundary = createManagedExecutionBoundary(
    createWorkspaceWritePermissionProfile(),
    0,
  );

  const outcomes = settleToolCallBatch(
    calls.map((call) => {
      const tool = tools.get(call.toolName);
      if (!tool) throw new Error(`${call.toolName} tool missing`);
      const ctx: MakaToolContext = {
        sessionId: 'filesystem-batch-session',
        turnId: 'filesystem-batch-turn',
        toolCallId: call.id,
        cwd,
        permissionMode: 'ask',
        executionBoundary,
        abortSignal,
        emitOutput: () => {},
      };
      return {
        id: call.id,
        signal: abortSignal,
        prepare: async () => {
          const operation = await preparation.prepare({ tool, input: call.input, ctx });
          claims.set(call.id, operation.claims);
          return operation;
        },
        run: async (operation): Promise<ScenarioValue> => {
          const fallbackEffect = async () => await tool.impl(call.input as never, ctx);
          const output = operation
            ? await operation.execute(abortSignal, fallbackEffect)
            : await fallbackEffect();
          return { id: call.id, output };
        },
      };
    }),
  );

  return { claims, outcomes };
}

class ControlledFilesystemWorker {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  private readonly counts = new Map<string, number>();
  private readonly gates = new Map<string, ReturnType<typeof deferred<void>>>();
  private readonly active = new Set<string>();
  private autoRelease = false;
  maxActive = 0;

  async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
    const observedPath = relative(input.cwd, input.operation.path) || '.';
    const base = `${input.operation.kind}:${observedPath.replaceAll('\\', '/')}`;
    const ordinal = (this.counts.get(base) ?? 0) + 1;
    this.counts.set(base, ordinal);
    const label = `${base}#${ordinal}`;
    const gate = deferred<void>();
    this.gates.set(label, gate);
    this.started.push(label);
    this.active.add(label);
    this.maxActive = Math.max(this.maxActive, this.active.size);
    if (this.autoRelease) gate.resolve();

    await gate.promise;
    this.active.delete(label);
    this.finished.push(label);
    return fakeWorkerResult(input);
  }

  release(label: string): void {
    const gate = this.gates.get(label);
    if (!gate) throw new Error(`Cannot release ${label}: operation has not started`);
    gate.resolve();
  }

  releaseAll(): void {
    this.autoRelease = true;
    for (const gate of this.gates.values()) gate.resolve();
  }

  async waitForStarted(labels: readonly string[]): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!labels.every((label) => this.started.includes(label))) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for [${labels.join(', ')}]; started=[${this.started.join(', ')}]`,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.resolve();
  }

  assertActive(expected: readonly string[]): void {
    assert.deepEqual([...this.active].sort(), [...expected].sort());
  }

  assertStarted(expected: readonly string[]): void {
    assert.deepEqual([...this.started].sort(), [...expected].sort());
  }
}

function fakeWorkerResult(input: FilesystemWorkerExecuteInput): FilesystemWorkerResult {
  switch (input.operation.kind) {
    case 'read':
      return { kind: 'read', content: `content:${input.operation.path}` };
    case 'write':
      return {
        kind: 'write',
        ok: true,
        path: input.operation.path,
        bytes: Buffer.byteLength(input.operation.content),
      };
    case 'apply_patch':
      return { kind: 'apply_patch', ok: true, path: input.operation.path };
    case 'edit':
      return {
        kind: 'edit',
        ok: true,
        path: input.operation.path,
        replacements: 1,
        matchedVia: 'exact',
        startLine: 1,
        endLine: 1,
      };
    case 'format_json':
      return {
        kind: 'format_json',
        ok: true,
        valid: true,
        path: input.operation.path,
        bytesBefore: 2,
        bytesAfter: 3,
        byteDelta: 1,
        changed: true,
      };
    case 'glob':
      return { kind: 'glob', files: [] };
    case 'grep':
      return { kind: 'grep', matches: [] };
  }
}

function assertClaims(
  actual: ReadonlyMap<string, readonly ResourceClaim[]>,
  cwd: string,
  expected: Readonly<Record<string, readonly string[]>>,
): void {
  const normalized = Object.fromEntries(
    [...actual].map(([id, claims]) => [id, claims.map((claim) => claimSignature(claim, cwd))]),
  );
  assert.deepEqual(normalized, expected);
}

function claimSignature(claim: ResourceClaim, cwd: string): string {
  if (claim.kind === 'all') return 'all';
  if (claim.kind !== 'keyed') return `${claim.kind}|${claim.authority}|${claim.key}`;
  const relativeKey = relative(cwd, claim.key).replaceAll('\\', '/') || '.';
  const key = process.platform === 'win32' ? relativeKey.toLowerCase() : relativeKey;
  return `${claim.authority}|${claim.mode}|${claim.scope ?? 'exact'}|${key}`;
}

function assertFulfilledInModelOrder(
  outcomes: PromiseSettledResult<ScenarioValue>[] | undefined,
  calls: readonly ScenarioCall[],
): void {
  assert.ok(outcomes);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    calls.map(() => 'fulfilled'),
  );
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value.id : undefined)),
    calls.map((call) => call.id),
  );
}

async function scenarioWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-filesystem-batch-'));
  cleanup.push(path);
  await Promise.all([
    mkdir(join(path, 'src'), { recursive: true }),
    mkdir(join(path, 'src2'), { recursive: true }),
    mkdir(join(path, 'other'), { recursive: true }),
  ]);
  return await realpath(path);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
