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
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  createBoundaryFilesystemExecutor,
  createFilesystemResourceOwner,
  type FilesystemResult,
} from '../filesystem-executor.js';
import { createFilesystemLeaseCoordinator } from '../filesystem-lease-coordinator.js';
import { hostFilesystemLeaseKey } from '../filesystem-lease-key.js';
import type { FilesystemWorkerExecuteInput } from '../filesystem-worker/client.js';
import { processAllOperation } from '../preparation/placeholder-authorities.js';
import type { AuthorityContext, PreparedOperation } from '../preparation/types.js';
import { createProcessResourceAdmissionCoordinator } from '../process-resource-admission.js';
import { settleToolCallBatch } from '../tool-call-batch.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';

test('prepared Write(create) then Read observes the admitted post-write identity', async (t) => {
  const cwd = await temporaryDirectory(t);
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
  });
  const write = await prepare(owner, cwd, 'write', {
    operation: { kind: 'write', path: 'created.txt', content: 'created' },
    cwd,
  });
  const read = await prepare(owner, cwd, 'read', {
    operation: { kind: 'read', path: 'created.txt' },
    cwd,
  });

  const writeResult = (await write.execute()) as FilesystemResult;
  const readResult = (await read.execute()) as FilesystemResult;

  assert.equal(writeResult.kind, 'write');
  assert.deepEqual(readResult, { kind: 'read', content: 'created' });
  assert.equal(await readFile(join(cwd, 'created.txt'), 'utf8'), 'created');
});

test('prepared Write(existing) then Read observes the new content', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'before', 'utf8');
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
  });
  const write = await prepare(owner, cwd, 'write', {
    operation: { kind: 'write', path: 'file.txt', content: 'after' },
    cwd,
  });
  const read = await prepare(owner, cwd, 'read', {
    operation: { kind: 'read', path: 'file.txt' },
    cwd,
  });

  await write.execute();
  assert.deepEqual(await read.execute(), { kind: 'read', content: 'after' });
});

test('independent direct batches share admission-relative identity through the coordinator', async (t) => {
  const cwd = await temporaryDirectory(t);
  let releaseWrite!: () => void;
  let markWriteAdmitted!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writeAdmitted = new Promise<void>((resolve) => {
    markWriteAdmitted = resolve;
  });
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    beforeTargetEffectForTest: async (target) => {
      if (target.identity.kind !== 'missing') return;
      markWriteAdmitted();
      await writeGate;
    },
  });
  const write = owner.executor.execute({
    operation: { kind: 'write', path: 'created.txt', content: 'created' },
    cwd,
  });
  await writeAdmitted;
  const read = owner.executor.execute({ operation: { kind: 'read', path: 'created.txt' }, cwd });

  releaseWrite();
  await write;
  assert.deepEqual(await read, { kind: 'read', content: 'created' });
});

test('real ToolCallBatch Write(create) then Read observes the created file', async (t) => {
  const cwd = await temporaryDirectory(t);
  const processAdmission = createProcessResourceAdmissionCoordinator();
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    processResourceAdmissionCoordinator: processAdmission,
  });
  const outcomes = await settleToolCallBatch(
    [
      {
        id: 'write',
        prepare: async () =>
          await prepare(owner, cwd, 'write', {
            operation: { kind: 'write', path: 'created.txt', content: 'created' },
            cwd,
          }),
        run: async (operation) => await operation?.execute(),
      },
      {
        id: 'read',
        prepare: async () =>
          await prepare(owner, cwd, 'read', {
            operation: { kind: 'read', path: 'created.txt' },
            cwd,
          }),
        run: async (operation) => await operation?.execute(),
      },
    ],
    { processAdmission },
  );

  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.deepEqual(outcomes[1], {
    status: 'fulfilled',
    value: { kind: 'read', content: 'created' },
  });
  assert.equal(await readFile(join(cwd, 'created.txt'), 'utf8'), 'created');
});

test('independent ToolCallBatches: active all blocks real Write and Read disk effects', async (t) => {
  const cwd = await temporaryDirectory(t);
  const target = join(cwd, 'created.txt');
  let releaseAll!: () => void;
  let markAllStarted!: () => void;
  let markSharedQueued!: () => void;
  const allGate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  t.after(() => releaseAll());
  const allStarted = new Promise<void>((resolve) => {
    markAllStarted = resolve;
  });
  const sharedQueued = new Promise<void>((resolve) => {
    markSharedQueued = resolve;
  });
  const processAdmission = createProcessResourceAdmissionCoordinator({
    onTransition: (transition) => {
      if (
        transition.process_admission_mode === 'shared' &&
        transition.process_admission_state === 'queued'
      ) {
        markSharedQueued();
      }
    },
  });
  let filesystemEffects = 0;
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    processResourceAdmissionCoordinator: processAdmission,
    beforeTargetEffectForTest: () => {
      filesystemEffects += 1;
    },
  });
  const allBatch = settleToolCallBatch(
    [
      {
        id: 'session-a-all',
        prepare: async () =>
          processAllOperation(async () => {
            markAllStarted();
            await allGate;
            return 'all';
          }, processAdmission),
        run: async (operation) => await operation?.execute(),
      },
    ],
    { processAdmission },
  );
  await allStarted;
  const filesystemBatch = settleToolCallBatch(
    [
      {
        id: 'session-b-write',
        prepare: async () =>
          await prepare(owner, cwd, 'session-b-write', {
            operation: { kind: 'write', path: 'created.txt', content: 'created' },
            cwd,
          }),
        run: async (operation) => await operation?.execute(),
      },
      {
        id: 'session-b-read',
        prepare: async () =>
          await prepare(owner, cwd, 'session-b-read', {
            operation: { kind: 'read', path: 'created.txt' },
            cwd,
          }),
        run: async (operation) => await operation?.execute(),
      },
    ],
    { processAdmission },
  );

  await sharedQueued;
  assert.equal(filesystemEffects, 0, 'neither real filesystem effect may pass active all()');
  await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' });

  releaseAll();
  assert.deepEqual(await allBatch, [{ status: 'fulfilled', value: 'all' }]);
  const outcomes = await filesystemBatch;
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.deepEqual(outcomes[1], {
    status: 'fulfilled',
    value: { kind: 'read', content: 'created' },
  });
  assert.equal(filesystemEffects, 2);
  assert.equal(await readFile(target, 'utf8'), 'created');
});

test('an atomic replacement owner then Read accepts the identity current at admission', async (t) => {
  const cwd = await temporaryDirectory(t);
  const target = join(cwd, 'file.txt');
  const replacement = join(cwd, 'replacement.txt');
  await writeFile(target, 'before', 'utf8');
  await writeFile(replacement, 'replacement', 'utf8');
  const coordinator = createFilesystemLeaseCoordinator();
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: coordinator,
  });
  const read = await prepare(owner, cwd, 'read', {
    operation: { kind: 'read', path: 'file.txt' },
    cwd,
  });

  await coordinator.withLease(
    {
      key: hostFilesystemLeaseKey(target),
      mode: 'write',
      scope: 'exact',
    },
    undefined,
    async () => await rename(replacement, target),
  );

  assert.deepEqual(await read.execute(), { kind: 'read', content: 'replacement' });
  assert.equal(await readFile(target, 'utf8'), 'replacement');
});

test('ApplyPatch captures identity per operation for create then same-key update', async (t) => {
  const cwd = await temporaryDirectory(t);
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
  });

  const result = await filesystem.applyPatchBatch({
    cwd,
    operations: [
      { type: 'create_file', path: 'file.txt', diff: '+created\n' },
      { type: 'update_file', path: 'file.txt', diff: '@@\n-created\n+updated\n' },
    ],
  });

  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'updated');
  assert.deepEqual(
    await filesystem.execute({ operation: { kind: 'read', path: 'file.txt' }, cwd }),
    { kind: 'read', content: 'updated' },
  );
});

test('prepared ApplyPatch(create) then Read observes the created inode', async (t) => {
  const cwd = await temporaryDirectory(t);
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
  });
  const abortSignal = new AbortController().signal;
  const patch = await owner.authority.preparePatchBatch(
    [{ type: 'create_file', path: 'file.txt', diff: '+patched\n' }],
    authorityContext(cwd, 'patch', abortSignal),
  );
  const read = await prepare(owner, cwd, 'read', {
    operation: { kind: 'read', path: 'file.txt' },
    cwd,
  });

  assert.equal((await patch.execute(abortSignal)).status, 'completed');
  assert.deepEqual(await read.execute(), { kind: 'read', content: 'patched' });
});

test('prepared delete then create then Read observes the final logical path state', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'old', 'utf8');
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
  });
  const remove = await prepare(owner, cwd, 'delete', {
    operation: { type: 'delete_file', path: 'file.txt' },
    cwd,
  });
  const create = await prepare(owner, cwd, 'create', {
    operation: { type: 'create_file', path: 'file.txt', diff: '+new\n' },
    cwd,
  });
  const read = await prepare(owner, cwd, 'read', {
    operation: { kind: 'read', path: 'file.txt' },
    cwd,
  });

  await remove.execute();
  await create.execute();
  assert.deepEqual(await read.execute(), { kind: 'read', content: 'new' });
});

test('claim drift after prepare fails before the backend effect starts', async (t) => {
  const root = await temporaryDirectory(t);
  const first = join(root, 'first');
  const second = join(root, 'second');
  const alias = join(root, 'alias');
  await Promise.all([mkdir(first), mkdir(second)]);
  await Promise.all([
    writeFile(join(first, 'file.txt'), 'first', 'utf8'),
    writeFile(join(second, 'file.txt'), 'second', 'utf8'),
  ]);
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let effects = 0;
  const owner = createFilesystemResourceOwner({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    beforeTargetEffectForTest: () => {
      effects += 1;
    },
  });
  const read = await prepare(owner, alias, 'read', {
    operation: { kind: 'read', path: 'file.txt' },
    cwd: alias,
  });

  await unlink(alias);
  await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(read.execute(), { code: 'filesystem_prepared_claim_changed' });
  assert.equal(effects, 0);
});

test('pinned Read rejects replacement after admission and never returns replacement content', async (t) => {
  const cwd = await temporaryDirectory(t);
  const target = join(cwd, 'file.txt');
  const replacement = join(cwd, 'replacement.txt');
  await writeFile(target, 'original', 'utf8');
  await writeFile(replacement, 'replacement', 'utf8');
  let swapped = false;
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    beforeTargetEffectForTest: async () => {
      if (swapped) return;
      swapped = true;
      await rename(replacement, target);
    },
  });

  await assert.rejects(filesystem.execute({ operation: { kind: 'read', path: 'file.txt' }, cwd }), {
    code: 'path_changed',
  });
  assert.equal(await readFile(target, 'utf8'), 'replacement');
});

test('pinned Write rejects replacement after admission without modifying it', async (t) => {
  const cwd = await temporaryDirectory(t);
  const target = join(cwd, 'file.txt');
  const replacement = join(cwd, 'replacement.txt');
  await writeFile(target, 'original', 'utf8');
  await writeFile(replacement, 'replacement', 'utf8');
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    beforeTargetEffectForTest: async () => await rename(replacement, target),
  });

  await assert.rejects(
    filesystem.execute({ operation: { kind: 'write', path: 'file.txt', content: 'changed' }, cwd }),
    { code: 'path_changed' },
  );
  assert.equal(await readFile(target, 'utf8'), 'replacement');
});

test('compare-and-delete rejects replacement after admission without deleting it', async (t) => {
  const cwd = await temporaryDirectory(t);
  const target = join(cwd, 'file.txt');
  const replacement = join(cwd, 'replacement.txt');
  await writeFile(target, 'original', 'utf8');
  await writeFile(replacement, 'replacement', 'utf8');
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    beforeTargetEffectForTest: async () => await rename(replacement, target),
  });

  await assert.rejects(
    filesystem.applyPatch({ operation: { type: 'delete_file', path: 'file.txt' }, cwd }),
    { code: 'path_changed' },
  );
  assert.equal(await readFile(target, 'utf8'), 'replacement');
});

test('worker-backed exact Read receives the admission identity', async (t) => {
  const cwd = await temporaryDirectory(t);
  await writeFile(join(cwd, 'file.txt'), 'content', 'utf8');
  let received: FilesystemWorkerExecuteInput['expectedIdentity'];
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    filesystemLeaseCoordinator: createFilesystemLeaseCoordinator(),
    worker: {
      async execute(input) {
        received = input.expectedIdentity;
        return { kind: 'read', content: 'content' };
      },
    },
  });

  assert.deepEqual(
    await filesystem.execute({ operation: { kind: 'read', path: 'file.txt' }, cwd }),
    { kind: 'read', content: 'content' },
  );
  assert.ok(received && typeof received === 'object');
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'maka-admission-identity-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function prepare(
  owner: ReturnType<typeof createFilesystemResourceOwner>,
  cwd: string,
  toolCallId: string,
  input: Parameters<typeof owner.authority.prepare>[0],
): Promise<PreparedOperation<unknown>> {
  const abortSignal = new AbortController().signal;
  const context: AuthorityContext = {
    ...authorityContext(cwd, toolCallId, abortSignal),
  };
  return await owner.authority.prepare({ ...input, abortSignal }, context);
}

function authorityContext(
  cwd: string,
  toolCallId: string,
  abortSignal: AbortSignal,
): AuthorityContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    toolCallId,
    cwd,
    abortSignal,
  };
}
