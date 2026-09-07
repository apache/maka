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
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBuiltinToolComposition } from '../builtin-tools.js';
import { createFilesystemResourceOwner, type FilesystemResult } from '../filesystem-executor.js';
import { createFilesystemLeaseCoordinator } from '../filesystem-lease-coordinator.js';
import type { FilesystemWorkerExecuteInput } from '../filesystem-worker/client.js';
import type { FilesystemWorkerResult } from '../filesystem-worker/protocol.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import type { AuthorityContext } from '../preparation/types.js';
import { createProcessResourceAdmissionCoordinator } from '../process-resource-admission.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('direct filesystem execution participates in the process-wide all() barrier', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-process-fs-')));
  try {
    await writeFile(join(cwd, 'shared.txt'), 'before', 'utf8');
    const processAdmission = createProcessResourceAdmissionCoordinator();
    const releaseAll = deferred();
    const allStarted = deferred();
    const readStarted = deferred();
    let workerCalls = 0;
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
      processResourceAdmissionCoordinator: processAdmission,
      worker: {
        async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
          workerCalls += 1;
          assert.equal(input.operation.kind, 'read');
          readStarted.resolve();
          return { kind: 'read', content: 'before' };
        },
      },
    });
    const all = processAdmission.withExclusive(undefined, async () => {
      allStarted.resolve();
      await releaseAll.promise;
    });
    await allStarted.promise;
    const read = owner.executor.execute({
      operation: { kind: 'read', path: 'shared.txt' },
      cwd,
    });
    await Promise.resolve();
    assert.equal(workerCalls, 0, 'the filesystem worker must remain behind active all()');

    releaseAll.resolve();
    await all;
    await readStarted.promise;
    assert.equal((await read).kind, 'read');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('active direct filesystem execution blocks a later all() holder', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-fs-process-')));
  try {
    await writeFile(join(cwd, 'shared.txt'), 'before', 'utf8');
    const processAdmission = createProcessResourceAdmissionCoordinator();
    const readStarted = deferred();
    const releaseRead = deferred();
    let allStarted = false;
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
      processResourceAdmissionCoordinator: processAdmission,
      worker: {
        async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
          assert.equal(input.operation.kind, 'read');
          readStarted.resolve();
          await releaseRead.promise;
          return { kind: 'read', content: 'before' };
        },
      },
    });
    const read = owner.executor.execute({
      operation: { kind: 'read', path: 'shared.txt' },
      cwd,
    });
    await readStarted.promise;
    const all = processAdmission.withExclusive(undefined, async () => {
      allStarted = true;
    });
    assert.equal(allStarted, false);

    releaseRead.resolve();
    await read;
    assert.equal(allStarted, true);
    await all;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('direct and prepared filesystem operations share the owner lease without Scheduler help', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-authority-leases-')));
  try {
    const target = join(cwd, 'shared.txt');
    await writeFile(target, 'before', 'utf8');
    const readStarted = deferred();
    const releaseRead = deferred();
    const calls: FilesystemWorkerExecuteInput[] = [];
    const worker = {
      async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
        calls.push(input);
        if (input.operation.kind === 'read') {
          readStarted.resolve();
          await releaseRead.promise;
          return { kind: 'read', content: 'before' };
        }
        if (input.operation.kind === 'write') {
          return { kind: 'write', ok: true, path: input.operation.path, bytes: 5 };
        }
        throw new Error(`Unexpected operation ${input.operation.kind}`);
      },
    };
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      worker,
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    });
    const abortSignal = new AbortController().signal;
    const context: AuthorityContext = {
      sessionId: 'session',
      turnId: 'turn',
      toolCallId: 'read',
      cwd,
      abortSignal,
    };
    const prepared = await owner.authority.prepare(
      { operation: { kind: 'read', path: 'shared.txt' }, cwd, abortSignal },
      context,
    );
    assert.deepEqual(prepared.claims, [
      {
        kind: 'keyed',
        authority: 'filesystem:workspace',
        key: process.platform === 'win32' ? target.toUpperCase() : target,
        mode: 'read',
        scope: 'exact',
      },
    ]);

    const read = prepared.execute(abortSignal) as Promise<FilesystemResult>;
    await readStarted.promise;
    const write = owner.executor.execute({
      operation: { kind: 'write', path: 'shared.txt', content: 'after' },
      cwd,
      abortSignal,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, 1, 'the conflicting direct write must remain queued');
    assert.equal(calls[0]?.operation.path, target, 'the backend receives the canonical path');

    releaseRead.resolve();
    await read;
    const writeResult = await write;
    assert.equal(writeResult.kind, 'write');
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.operation.path, target);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('prepared Read blocks a direct same-file Edit without Scheduler help', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-read-edit-leases-')));
  try {
    const target = join(cwd, 'shared.txt');
    await writeFile(target, 'before', 'utf8');
    const readStarted = deferred();
    const releaseRead = deferred();
    const calls: string[] = [];
    const worker = {
      async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
        calls.push(input.operation.kind);
        if (input.operation.kind === 'read') {
          readStarted.resolve();
          await releaseRead.promise;
          return { kind: 'read', content: 'before' };
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
          };
        }
        throw new Error(`Unexpected operation ${input.operation.kind}`);
      },
    };
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      worker,
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    });
    const abortSignal = new AbortController().signal;
    const prepared = await owner.authority.prepare(
      { operation: { kind: 'read', path: 'shared.txt' }, cwd, abortSignal },
      {
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'read',
        cwd,
        abortSignal,
      },
    );

    const read = prepared.execute(abortSignal);
    await readStarted.promise;
    const edit = owner.executor.execute({
      operation: {
        kind: 'edit',
        path: 'shared.txt',
        oldString: 'before',
        newString: 'after',
      },
      cwd,
      abortSignal,
    });
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

test('structured single-operation patch blocks overlapping Read and Grep directly', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-structured-patch-leases-')));
  try {
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'a.txt'), 'before', 'utf8');
    const patchStarted = deferred();
    const releasePatch = deferred();
    const calls: string[] = [];
    const worker = {
      async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
        calls.push(input.operation.kind);
        if (input.operation.kind === 'apply_patch') {
          patchStarted.resolve();
          await releasePatch.promise;
          return { kind: 'apply_patch', ok: true, path: input.operation.path };
        }
        if (input.operation.kind === 'read') {
          return { kind: 'read', content: 'after' };
        }
        if (input.operation.kind === 'grep') {
          return { kind: 'grep', matches: [] };
        }
        throw new Error(`Unexpected operation ${input.operation.kind}`);
      },
    };
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      worker,
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    });
    const patch = owner.executor.applyPatch({
      operation: { type: 'update_file', path: 'src/a.txt', diff: '@@' },
      cwd,
    });
    await patchStarted.promise;
    const read = owner.executor.execute({ operation: { kind: 'read', path: 'src/a.txt' }, cwd });
    const grep = owner.executor.execute({
      operation: {
        kind: 'grep',
        path: 'src',
        pattern: 'after',
        maxCountPerFile: 100,
        limit: 100,
        timeoutMs: 2_000,
      },
      cwd,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ['apply_patch']);

    releasePatch.resolve();
    await Promise.all([patch, read, grep]);
    assert.equal(calls[0], 'apply_patch');
    assert.deepEqual(calls.slice(1).sort(), ['grep', 'read']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('prepared junction or symlink aliases share the canonical lease key', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-prepared-alias-leases-')));
  try {
    const cwd = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'shared.txt'), 'before', 'utf8');
    await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const readStarted = deferred();
    const releaseRead = deferred();
    const calls: string[] = [];
    const worker = {
      async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
        calls.push(input.operation.kind);
        if (input.operation.kind === 'read') {
          readStarted.resolve();
          await releaseRead.promise;
          return { kind: 'read', content: 'before' };
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
          };
        }
        throw new Error(`Unexpected operation ${input.operation.kind}`);
      },
    };
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      worker,
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    });
    const abortSignal = new AbortController().signal;
    const prepared = await owner.authority.prepare(
      { operation: { kind: 'read', path: 'shared.txt' }, cwd: alias, abortSignal },
      {
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'aliased-read',
        cwd: alias,
        abortSignal,
      },
    );
    const read = prepared.execute(abortSignal);
    await readStarted.promise;
    const edit = owner.executor.execute({
      operation: {
        kind: 'edit',
        path: 'shared.txt',
        oldString: 'before',
        newString: 'after',
      },
      cwd,
      abortSignal,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ['read']);

    releaseRead.resolve();
    await Promise.all([read, edit]);
    assert.deepEqual(calls, ['read', 'edit']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('multi-file patch holds every target lease as one interval while unrelated files fan out', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-patch-leases-')));
  try {
    const a = join(cwd, 'a.txt');
    const b = join(cwd, 'b.txt');
    const c = join(cwd, 'c.txt');
    await Promise.all([
      writeFile(a, 'a', 'utf8'),
      writeFile(b, 'b', 'utf8'),
      writeFile(c, 'c', 'utf8'),
    ]);
    const patchAStarted = deferred();
    const releasePatchA = deferred();
    const readCStarted = deferred();
    const calls: string[] = [];
    const worker = {
      async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
        const label = `${input.operation.kind}:${input.operation.path}`;
        calls.push(label);
        if (input.operation.kind === 'apply_patch') {
          if (input.operation.path === a) {
            patchAStarted.resolve();
            await releasePatchA.promise;
          }
          return { kind: 'apply_patch', ok: true, path: input.operation.path };
        }
        if (input.operation.kind === 'read') {
          if (input.operation.path === c) readCStarted.resolve();
          return { kind: 'read', content: input.operation.path };
        }
        throw new Error(`Unexpected operation ${input.operation.kind}`);
      },
    };
    const owner = createFilesystemResourceOwner({
      workspace: createLocalWorkspaceExecutor(),
      worker,
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    });
    const batch = owner.executor.applyPatchBatch({
      cwd,
      operations: [
        { type: 'update_file', path: 'a.txt', diff: '@@' },
        { type: 'update_file', path: 'b.txt', diff: '@@' },
      ],
    });
    await patchAStarted.promise;
    const readB = owner.executor.execute({ operation: { kind: 'read', path: 'b.txt' }, cwd });
    const readC = owner.executor.execute({ operation: { kind: 'read', path: 'c.txt' }, cwd });
    await readCStarted.promise;
    assert.deepEqual(calls, [`apply_patch:${a}`, `read:${c}`]);

    releasePatchA.resolve();
    const batchResult = await batch;
    assert.equal(batchResult.status, 'completed');
    await Promise.all([readB, readC]);
    assert.deepEqual(calls, [`apply_patch:${a}`, `read:${c}`, `apply_patch:${b}`, `read:${b}`]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('freeform multi-file patch prepare emits sorted exact-write claims instead of all()', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-patch-claims-')));
  try {
    const composition = buildBuiltinToolComposition({
      filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    });
    const tool = composition.tools.find((candidate) => candidate.name === 'apply_patch');
    assert.ok(tool);
    const abortSignal = new AbortController().signal;
    const operation = await new ToolPreparationService(composition.authorityRegistry).prepare({
      tool,
      input: [
        '*** Begin Patch',
        '*** Add File: b.txt',
        '+b',
        '*** Add File: a.txt',
        '+a',
        '*** End Patch',
      ].join('\n'),
      ctx: {
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'patch',
        cwd,
        abortSignal,
        emitOutput: () => {},
      },
    });
    const expected = [join(cwd, 'a.txt'), join(cwd, 'b.txt')].map((path) =>
      process.platform === 'win32' ? path.toUpperCase() : path,
    );
    assert.deepEqual(
      operation.claims.map((claim) =>
        claim.kind === 'keyed'
          ? { key: claim.key, mode: claim.mode, scope: claim.scope }
          : { kind: claim.kind },
      ),
      expected.map((key) => ({ key, mode: 'write', scope: 'exact' })),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
