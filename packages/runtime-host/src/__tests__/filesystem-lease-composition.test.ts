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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import {
  buildBuiltinToolComposition,
  buildBuiltinTools,
  type BuildBuiltinToolsOptions,
} from '@maka/runtime/builtin-tools';
import { createFilesystemLeaseCoordinator } from '@maka/runtime/filesystem-lease-coordinator';
import { createProcessResourceAdmissionCoordinator } from '@maka/runtime/process-resource-admission';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { createHostChildAgentToolComposition } from '../server/child-agent-composition.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('root and child tool compositions share one filesystem coordinator', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-root-child-leases-')));
  try {
    await writeFile(join(cwd, 'shared.txt'), 'before', 'utf8');
    const coordinator = createFilesystemLeaseCoordinator();
    const readStarted = deferred();
    const releaseRead = deferred();
    const calls: string[] = [];
    const filesystemWorker: NonNullable<BuildBuiltinToolsOptions['filesystemWorker']> = {
      async execute(input) {
        calls.push(input.operation.kind);
        if (input.operation.kind === 'read') {
          readStarted.resolve();
          await releaseRead.promise;
          return { kind: 'read', content: 'before' } as const;
        }
        if (input.operation.kind === 'edit') {
          return {
            kind: 'edit',
            ok: true,
            path: input.operation.path,
            replacements: 1,
            matchedVia: 'exact',
            startLine: 1,
            endLine: 1,
          } as const;
        }
        throw new Error(`Unexpected operation ${input.operation.kind}`);
      },
    };
    const rootRead = buildBuiltinTools({
      filesystemWorker,
      filesystemLeaseCoordinator: coordinator,
    }).find((tool) => tool.name === 'Read') as MakaTool<{ path: string }, unknown> | undefined;
    const childEdit = createHostChildAgentToolComposition({
      builtinTools: { filesystemWorker, filesystemLeaseCoordinator: coordinator },
      worktreePatchWriteBackAvailable: true,
    }).childTools.find((tool) => tool.name === 'Edit') as
      | MakaTool<{ path: string; old_string: string; new_string: string }, unknown>
      | undefined;
    assert.ok(rootRead);
    assert.ok(childEdit);
    const executionBoundary = createManagedExecutionBoundary(
      createWorkspaceWritePermissionProfile(),
      0,
    );
    const context = (toolCallId: string): MakaToolContext => ({
      sessionId: toolCallId === 'root-read' ? 'root-session' : 'child-session',
      turnId: 'turn',
      toolCallId,
      cwd,
      permissionMode: 'ask',
      executionBoundary,
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    });

    const read = rootRead.impl({ path: 'shared.txt' }, context('root-read'));
    await readStarted.promise;
    const edit = childEdit.impl(
      { path: 'shared.txt', old_string: 'before', new_string: 'after' },
      context('child-edit'),
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ['read']);

    releaseRead.resolve();
    await Promise.all([read, edit]);
    assert.deepEqual(calls, ['read', 'edit']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('root all() and child filesystem tools share one process admission coordinator', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-root-child-process-')));
  try {
    await writeFile(join(cwd, 'shared.txt'), 'before', 'utf8');
    const processAdmission = createProcessResourceAdmissionCoordinator();
    const releaseAll = deferred();
    const allStarted = deferred();
    let workerCalls = 0;
    const filesystemWorker: NonNullable<BuildBuiltinToolsOptions['filesystemWorker']> = {
      async execute(input) {
        workerCalls += 1;
        assert.equal(input.operation.kind, 'read');
        return { kind: 'read', content: 'before' } as const;
      },
    };
    const options: BuildBuiltinToolsOptions = {
      filesystemWorker,
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
      processResourceAdmissionCoordinator: processAdmission,
    };
    const root = buildBuiltinToolComposition(options);
    const rootAllAuthority = root.authorityRegistry.resolve('Bash');
    assert.ok(rootAllAuthority);
    const allOperation = await rootAllAuthority.prepare(
      {},
      {
        sessionId: 'root-session',
        turnId: 'root-turn',
        toolCallId: 'root-all',
        cwd,
        effect: async () => {
          allStarted.resolve();
          await releaseAll.promise;
        },
      },
    );
    const all = allOperation.execute();
    await allStarted.promise;

    const childRead = createHostChildAgentToolComposition({
      builtinTools: options,
      worktreePatchWriteBackAvailable: true,
    }).childTools.find((tool) => tool.name === 'Read') as
      | MakaTool<{ path: string }, unknown>
      | undefined;
    assert.ok(childRead);
    const read = childRead.impl(
      { path: 'shared.txt' },
      {
        sessionId: 'child-session',
        turnId: 'child-turn',
        toolCallId: 'child-read',
        cwd,
        permissionMode: 'ask',
        executionBoundary: createManagedExecutionBoundary(
          createWorkspaceWritePermissionProfile(),
          0,
        ),
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );
    await Promise.resolve();
    assert.equal(workerCalls, 0);

    releaseAll.resolve();
    await all;
    await read;
    assert.equal(workerCalls, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
