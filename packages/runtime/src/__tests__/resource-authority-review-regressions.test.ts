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
import { link, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { buildBuiltinToolComposition } from '../builtin-tools.js';
import { createFilesystemResourceOwner } from '../filesystem-executor.js';
import {
  createFilesystemLeaseCoordinator,
  type FilesystemLeaseCoordinator,
} from '../filesystem-lease-coordinator.js';
import { createProcessResourceAdmissionCoordinator } from '../process-resource-admission.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import { settleToolCallBatch } from '../tool-call-batch.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';
import type { ResourceClaim } from '../preparation/types.js';

function context(cwd: string) {
  return {
    cwd,
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

test('local delete preserves a file that appeared after missing admission', async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-delete-race-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const target = join(cwd, 'new.txt');
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    beforeTargetEffectForTest: async () => {
      await writeFile(target, 'keep me');
    },
  });
  const operation = await owner.authority.prepare(
    { cwd, operation: { type: 'delete_file', path: target } },
    context(cwd),
  );
  await assert.rejects(operation.execute(), /appeared after filesystem admission/);
  assert.equal(await readFile(target, 'utf8'), 'keep me');
});

for (const name of ['AskUserQuestion', 'request_sandbox_boundary']) {
  test(`${name} does not hold process admission while waiting for a response`, async () => {
    const admission = createProcessResourceAdmissionCoordinator();
    const composition = buildBuiltinToolComposition({
      processResourceAdmissionCoordinator: admission,
    });
    const service = new ToolPreparationService(composition.authorityRegistry, admission);
    const answer = deferred<void>();
    const entered = deferred<void>();
    const operation = await service.prepare({
      tool: {
        name,
        description: 'interaction probe',
        parameters: undefined,
        impl: async () => {
          entered.resolve();
          await answer.promise;
        },
      },
      input: {},
      ctx: context(process.cwd()),
    });
    const pending = operation.execute();
    await entered.promise;
    try {
      assert.equal(admission.inspect().activeExclusive, false);
      assert.equal(
        await admission.withShared(undefined, async () => 'filesystem ran'),
        'filesystem ran',
      );
    } finally {
      answer.resolve();
      await pending;
    }
  });
}

for (const mutation of ['write', 'patch'] as const) {
  test(`hard-link Read excludes ${mutation} through a separate owner`, async (t) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-hardlink-')));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    await writeFile(a, 'before');
    await link(a, b);
    const admitted = deferred<void>();
    const release = deferred<void>();
    const writeWaiting = deferred<void>();
    const coordinator = createFilesystemLeaseCoordinator();
    const sharedCoordinator: FilesystemLeaseCoordinator = {
      ...coordinator,
      withLeases: (requests, signal, effect) => {
        if (
          requests.some((request) => request.key.startsWith('\0inode:') && request.mode === 'write')
        )
          writeWaiting.resolve();
        return coordinator.withLeases(requests, signal, effect);
      },
    };
    const reader = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      filesystemLeaseCoordinator: coordinator,
      beforeTargetEffectForTest: async () => {
        admitted.resolve();
        await release.promise;
      },
    });
    let writes = 0;
    const writer = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      filesystemLeaseCoordinator: sharedCoordinator,
      beforeTargetEffectForTest: async () => {
        writes += 1;
        writeWaiting.resolve();
      },
    });
    const read = reader.executor.execute({ cwd, operation: { kind: 'read', path: a } });
    await admitted.promise;
    const write =
      mutation === 'write'
        ? writer.executor.execute({ cwd, operation: { kind: 'write', path: b, content: 'after' } })
        : writer.executor.applyPatchBatch({
            cwd,
            operations: [{ type: 'update_file', path: b, diff: '@@\n-before\n+after\n' }],
          });
    try {
      await writeWaiting.promise;
      assert.equal(writes, 0);
      assert.equal(await readFile(a, 'utf8'), 'before');
    } finally {
      release.resolve();
    }
    const result = await read;
    assert.equal(result.kind === 'read' && result.content, 'before');
    await write;
    assert.equal(await readFile(a, 'utf8'), 'after');
  });
}

test('provider-order rejection retains the fatal cause behind an earlier queued slot', async () => {
  const active = deferred<void>();
  const fatal = new Error('T1 ROOT CAUSE');
  const claims: ResourceClaim[] = [
    { kind: 'keyed', authority: 'filesystem', key: '/a', mode: 'write' },
  ];
  let queuedRan = false;
  const outcomes = await settleToolCallBatch([
    {
      id: 'active',
      prepare: async () => ({ claims, execute: async () => {} }),
      run: () => active.promise,
    },
    {
      id: 'queued',
      prepare: async () => ({ claims, execute: async () => {} }),
      run: async () => {
        queuedRan = true;
      },
    },
    {
      id: 'fatal',
      prepare: async () => ({ claims: [], execute: async () => {} }),
      run: async () => {
        queueMicrotask(() => active.resolve());
        throw fatal;
      },
    },
  ]);
  assert.equal(queuedRan, false);
  const rejection = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  assert.equal(rejection?.reason, fatal);
});

for (const name of ['Read', 'Glob', 'Grep']) {
  test(`prepared ${name} preserves the current builtin result contract`, async (t) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-prepared-result-')));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, 'file.txt'), 'match\n'.repeat(15000));
    const composition = buildBuiltinToolComposition();
    const service = new ToolPreparationService(composition.authorityRegistry);
    const tool = composition.tools.find((candidate) => candidate.name === name)!;
    const ctx = context(cwd);
    const input =
      name === 'Read'
        ? { path: 'file.txt' }
        : name === 'Glob'
          ? { pattern: '*.txt' }
          : { pattern: 'match', path: 'file.txt' };
    const operation = await service.prepare({ tool, input, ctx });
    const prepared = await operation.execute();
    const direct = await tool.impl(input, ctx);
    assert.deepEqual(prepared, direct);
    if (name === 'Read') {
      const next = (prepared as { next: { path: string } | null }).next;
      assert.ok(next, 'long reads must return a continuation');
      const page = await service.prepare({ tool, input: next, ctx });
      assert.deepEqual(await page.execute(), await tool.impl(next, ctx));
    }
  });
}
