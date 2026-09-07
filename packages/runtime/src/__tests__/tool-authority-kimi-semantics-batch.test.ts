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
import { claimsConflict } from '../preparation/claims.js';
import { defaultToolAuthorityRegistrations } from '../preparation/default-tool-authorities.js';
import { noneOperation } from '../preparation/placeholder-authorities.js';
import { ToolAuthorityRegistry } from '../preparation/tool-authority-registry.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import type {
  AuthorityContext,
  PreparedOperation,
  ResourceAuthority,
  ResourceClaim,
} from '../preparation/types.js';
import { settleToolCallBatch, type ToolCallBatchEntry } from '../tool-call-batch.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const FILE = 'filesystem:test';
const read = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'read' },
];
const write = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'write' },
];
const tree = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'read', scope: 'tree' },
];
const all = (): ResourceClaim[] => [{ kind: 'all' }];
const none = (): ResourceClaim[] => [];

describe('Kimi claim predicate', () => {
  test('C01: all conflicts with every non-empty modelled claim', () => {
    assert.equal(claimsConflict(all(), read('a')), true);
    assert.equal(claimsConflict(all(), write('a')), true);
    assert.equal(claimsConflict(all(), tree('src')), true);
    assert.equal(
      claimsConflict(all(), [{ kind: 'capacity', authority: 'web', key: 'p', permits: 1 }]),
      true,
    );
    assert.equal(claimsConflict(all(), [{ kind: 'coarse', authority: 'shell', key: 'w' }]), true);
    assert.equal(claimsConflict(all(), all()), true);
  });

  test('C02: all and none do not conflict in either direction', () => {
    assert.equal(claimsConflict(all(), none()), false);
    assert.equal(claimsConflict(none(), all()), false);
    assert.equal(claimsConflict(none(), none()), false);
  });

  test('C03: keyed read/write and tree boundaries retain their semantics', () => {
    assert.equal(claimsConflict(read('a'), read('a')), false);
    assert.equal(claimsConflict(read('a'), write('a')), true);
    assert.equal(claimsConflict(write('a'), write('b')), false);
    assert.equal(claimsConflict(tree('src'), write('src/a')), true);
    assert.equal(claimsConflict(tree('src'), write('src2/a')), false);
  });
});

describe('Kimi ToolCallBatch semantics', () => {
  test('B01: all blocks a later filesystem claim', async () => {
    const h = harness([call('update_agent_graph', 'all'), call('Read', 'read', 'a')]);
    const batch = h.run();
    await h.waitStarted('all');
    await h.expectStarted('all');
    h.finish('all');
    await h.waitStarted('read');
    h.finish('read');
    assertSlots(await batch, ['all', 'read']);
  });

  test('B02: all does not block none', async () => {
    const h = harness([call('update_agent_graph', 'all'), call('WebSearch', 'web')]);
    const batch = h.run();
    await Promise.all([h.waitStarted('all'), h.waitStarted('web')]);
    await h.expectStarted('all', 'web');
    h.finish('web');
    h.finish('all');
    assertSlots(await batch, ['all', 'web']);
  });

  test('B03: queued all prevents a later independent reader from bypassing', async () => {
    const h = harness([
      call('Read', 'read-a', 'a'),
      call('update_agent_graph', 'all'),
      call('Read', 'read-b', 'b'),
    ]);
    const batch = h.run();
    await h.waitStarted('read-a');
    await h.expectStarted('read-a');
    h.finish('read-a');
    await h.waitStarted('all');
    await h.expectStarted('read-a', 'all');
    h.finish('all');
    await h.waitStarted('read-b');
    h.finish('read-b');
    assertSlots(await batch, ['read-a', 'all', 'read-b']);
  });

  test('B04: none bypasses queued all and remains concurrent with it', async () => {
    const h = harness([
      call('Read', 'read', 'a'),
      call('update_agent_graph', 'all'),
      call('WebSearch', 'web'),
    ]);
    const batch = h.run();
    await Promise.all([h.waitStarted('read'), h.waitStarted('web')]);
    await h.expectStarted('read', 'web');
    h.finish('read');
    await h.waitStarted('all');
    await h.expectActive('all', 'web');
    h.finish('all');
    h.finish('web');
    assertSlots(await batch, ['read', 'all', 'web']);
  });

  test('B05: active all blocks only non-empty claims', async () => {
    const h = harness([
      call('WebSearch', 'web'),
      call('update_agent_graph', 'all'),
      call('Write', 'write', 'a'),
      call('agent_output', 'agent-output'),
    ]);
    const batch = h.run();
    await Promise.all([h.waitStarted('web'), h.waitStarted('all'), h.waitStarted('agent-output')]);
    await h.expectActive('web', 'all', 'agent-output');
    h.finish('all');
    await h.waitStarted('write');
    h.finish('web');
    h.finish('agent-output');
    h.finish('write');
    assertSlots(await batch, ['web', 'all', 'write', 'agent-output']);
  });

  test('B06: registry miss defaults to all and participates in fairness', async () => {
    const h = harness([
      call('Read', 'read', 'a'),
      call('UnknownMcpTool', 'unknown'),
      call('WebFetch', 'fetch'),
      call('Write', 'write', 'b'),
    ]);
    const batch = h.run();
    await Promise.all([h.waitStarted('read'), h.waitStarted('fetch')]);
    await h.expectStarted('read', 'fetch');
    h.finish('read');
    await h.waitStarted('unknown');
    await h.expectActive('unknown', 'fetch');
    h.finish('unknown');
    await h.waitStarted('write');
    h.finish('fetch');
    h.finish('write');
    assertSlots(await batch, ['read', 'unknown', 'fetch', 'write']);
  });

  test('B07: keyed writer fairness composes with an all barrier', async () => {
    const h = harness([
      call('Read', 'read-a', 'a'),
      call('Write', 'write-a', 'a'),
      call('update_agent_graph', 'all'),
      call('WebSearch', 'web'),
      call('Read', 'read-b', 'b'),
    ]);
    const batch = h.run();
    await Promise.all([h.waitStarted('read-a'), h.waitStarted('web')]);
    await h.expectStarted('read-a', 'web');
    h.finish('read-a');
    await h.waitStarted('write-a');
    h.finish('write-a');
    await h.waitStarted('all');
    h.finish('all');
    await h.waitStarted('read-b');
    h.finish('web');
    h.finish('read-b');
    assertSlots(await batch, ['read-a', 'write-a', 'all', 'web', 'read-b']);
  });

  test('B08: all claims serialize with each other while none passes through', async () => {
    const h = harness([
      call('Bash', 'bash'),
      call('update_agent_graph', 'all'),
      call('WebSearch', 'web'),
    ]);
    const batch = h.run();
    await Promise.all([h.waitStarted('bash'), h.waitStarted('web')]);
    await h.expectStarted('bash', 'web');
    h.finish('bash');
    await h.waitStarted('all');
    await h.expectActive('all', 'web');
    h.finish('all');
    h.finish('web');
    assertSlots(await batch, ['bash', 'all', 'web']);
  });

  test('B09: synthetic none creates no effect and no extra blocking', async () => {
    const h = harness([
      call('Read', 'read', 'a'),
      synthetic('synthetic'),
      call('Write', 'write', 'a'),
    ]);
    const batch = h.run();
    await h.waitStarted('read');
    await h.expectStarted('read');
    h.finish('read');
    await h.waitStarted('write');
    h.finish('write');
    assertSlots(await batch, ['read', 'synthetic', 'write']);
    assert.equal(h.starts.includes('synthetic'), false);
  });

  test('B10: prepare rejection runs the real fallback effect under all claims once', async () => {
    const h = harness([
      call('Read', 'read-a', 'a'),
      broken('broken'),
      call('WebFetch', 'fetch'),
      call('Read', 'read-b', 'b'),
    ]);
    const batch = h.run();
    await Promise.all([h.waitStarted('read-a'), h.waitStarted('fetch')]);
    await h.expectStarted('read-a', 'fetch');
    h.finish('read-a');
    await h.waitStarted('broken');
    await h.expectActive('broken', 'fetch');
    h.finish('broken');
    await h.waitStarted('read-b');
    h.finish('fetch');
    h.finish('read-b');
    assertSlots(await batch, ['read-a', 'broken', 'fetch', 'read-b']);
    assert.equal(h.starts.filter((id) => id === 'broken').length, 1);
  });

  test('B11: completion order never changes provider-order result slots', async () => {
    const h = harness([
      call('WebSearch', 'a'),
      call('WebFetch', 'b'),
      call('agent_list', 'c'),
      call('agent_output', 'd'),
    ]);
    const batch = h.run();
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => h.waitStarted(id)));
    h.finish('d');
    await flushMicrotasks();
    h.finish('b');
    await flushMicrotasks();
    h.finish('a');
    await flushMicrotasks();
    h.finish('c');
    assertSlots(await batch, ['a', 'b', 'c', 'd']);
  });
});

type CallSpec =
  | { readonly kind: 'real'; readonly toolName: string; readonly id: string; readonly key?: string }
  | { readonly kind: 'synthetic'; readonly id: string }
  | { readonly kind: 'broken'; readonly id: string };

function call(toolName: string, id: string, key?: string): CallSpec {
  return { kind: 'real', toolName, id, ...(key ? { key } : {}) };
}

function synthetic(id: string): CallSpec {
  return { kind: 'synthetic', id };
}

function broken(id: string): CallSpec {
  return { kind: 'broken', id };
}

function harness(specs: readonly CallSpec[]) {
  const starts: string[] = [];
  const active = new Set<string>();
  const startSignals = new Map(specs.map((spec) => [spec.id, deferred<void>()]));
  const finishSignals = new Map(specs.map((spec) => [spec.id, deferred<void>()]));
  const exactAuthority = (mode: 'read' | 'write'): ResourceAuthority<unknown, unknown> => ({
    async prepare(input, context: AuthorityContext) {
      const key = (input as { key?: string }).key ?? 'default';
      return {
        claims: [{ kind: 'keyed', authority: FILE, key, mode }],
        execute: (signal) => context.effect?.(signal) ?? Promise.resolve(),
      };
    },
  });
  const registry = new ToolAuthorityRegistry([
    ['Read', exactAuthority('read')],
    ['Write', exactAuthority('write')],
    ['BrokenPreparedTool', { prepare: async () => Promise.reject(new Error('broken prepare')) }],
  ]).withRegistrations(defaultToolAuthorityRegistrations());
  const service = new ToolPreparationService(registry);
  const context = (id: string): MakaToolContext => ({
    sessionId: 'session',
    turnId: 'turn',
    cwd: process.cwd(),
    permissionMode: 'ask',
    toolCallId: id,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  });
  const toolFor = (name: string, id: string): MakaTool => ({
    name,
    description: 'Kimi semantics test tool',
    parameters: undefined,
    impl: async () => {
      starts.push(id);
      active.add(id);
      startSignals.get(id)!.resolve();
      await finishSignals.get(id)!.promise;
      active.delete(id);
      return id;
    },
  });
  const entries = specs.map<ToolCallBatchEntry<string>>((spec) => {
    if (spec.kind === 'synthetic') {
      return {
        id: spec.id,
        prepare: async () => noneOperation(),
        run: async (operation) => {
          await operation?.execute();
          return spec.id;
        },
      };
    }
    const toolName = spec.kind === 'broken' ? 'BrokenPreparedTool' : spec.toolName;
    const tool = toolFor(toolName, spec.id);
    const ctx = context(spec.id);
    const input = spec.kind === 'real' ? { key: spec.key } : {};
    return {
      id: spec.id,
      prepare: () => service.prepare({ tool, input, ctx }),
      run: async (operation) => {
        if (operation) return (await operation.execute()) as string;
        return (await tool.impl(input as never, ctx)) as string;
      },
    };
  });

  return {
    starts,
    run: () => settleToolCallBatch(entries),
    waitStarted: (id: string) => startSignals.get(id)!.promise,
    finish(id: string) {
      finishSignals.get(id)!.resolve();
    },
    async expectStarted(...ids: string[]) {
      await flushMicrotasks();
      assert.deepEqual(new Set(starts), new Set(ids));
    },
    async expectActive(...ids: string[]) {
      await flushMicrotasks();
      assert.deepEqual(active, new Set(ids));
    },
  };
}

function assertSlots(outcomes: readonly PromiseSettledResult<string>[], ids: readonly string[]) {
  assert.deepEqual(
    outcomes.map((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : `rejected:${String(outcome.reason)}`,
    ),
    ids,
  );
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
