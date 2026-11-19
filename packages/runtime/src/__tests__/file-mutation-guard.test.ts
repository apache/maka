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
import { mkdtemp, readFile, realpath, rm, writeFile, rename, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import type { RuntimeCommitSink, ToolPreparedCommit } from '../runtime-commit-sink.js';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import { createLocalWorkspaceExecutor, LocalWorkspaceExecutor } from '../workspace-executor.js';
import { createBoundaryFilesystemExecutor } from '../filesystem-executor.js';
import {
  FILE_MUTATION_MAX_BYTES,
  FileMutationGuardSchema,
  type FileMutationGuard,
} from '../file-mutation-guard-contract.js';
import {
  prepareFileMutation,
  fileMutationInputEligible,
  executePreparedFileMutation,
} from '../file-mutation-guard.js';
import { runFilesystemWorkerProcess } from '../filesystem-worker/process-runner.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  parseFilesystemWorkerResponse,
} from '../filesystem-worker/protocol.js';

async function fixture(t: TestContext, kind: 'write' | 'edit' = 'write') {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-write-evidence-')));
  const path = join(cwd, 'notes.txt');
  const dbPath = join(cwd, 'runtime.sqlite');
  const store = createSqliteRuntimeStore(dbPath);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const executor = createLocalWorkspaceExecutor();
  const filesystem = createBoundaryFilesystemExecutor({ workspace: executor });
  const tool = buildBuiltinTools({ executor }).find(
    (candidate) => candidate.name === (kind === 'write' ? 'Write' : 'Edit'),
  )!;
  const call = (signal?: AbortSignal) => ({
    operation:
      kind === 'write'
        ? { kind: 'write' as const, path, content: 'after\n' }
        : { kind: 'edit' as const, path, oldString: 'before', newString: 'after' },
    cwd,
    executionBoundary: { kind: 'bypass' as const, revision: 0 },
    abortSignal: signal,
  });
  function execute(sink: RuntimeCommitSink = store, abortSignal = new AbortController().signal) {
    let id = 0;
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      runId: 'run-1',
      invocationId: 'invocation-1',
      header: {
        id: 'session-1',
        cwd,
        workspaceRoot: cwd,
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
        llmConnectionSlug: 'test',
        connectionLocked: true,
        model: 'test',
        permissionMode: 'bypass',
        schemaVersion: 1,
      },
      connection: { slug: 'test', providerType: 'openai', defaultModel: 'test' },
      modelId: 'test',
      newId: () => `event-${++id}`,
      now: () => ++id,
      getPermissionPauseTarget: () => null,
      readExecutionBoundary: async () => ({ kind: 'bypass', revision: 0 }),
      runtimeCommitSink: sink,
    });
    return runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: 'provider-call-1',
      input:
        kind === 'write'
          ? { path, content: 'after\n' }
          : { path, old_string: 'before', new_string: 'after' },
      abortSignal,
      eventSink: { push: () => {}, pushAndWaitUntilConsumed: async () => {} },
    });
  }
  return { cwd, path, dbPath, store, filesystem, call, execute };
}

test('prepared writes reject inode replacement and a file appearing at a missing target', async (t) => {
  const f = await fixture(t);
  const missing = await f.filesystem.prepareMutation(f.call());
  await writeFile(f.path, 'external create');
  await assert.rejects(missing.execute(), /appeared|created/);
  assert.equal(await readFile(f.path, 'utf8'), 'external create');
  const existing = await f.filesystem.prepareMutation(f.call());
  await rename(f.path, join(f.cwd, 'old.txt'));
  await writeFile(f.path, 'replacement');
  await assert.rejects(existing.execute(), /changed/);
  assert.equal(await readFile(f.path, 'utf8'), 'replacement');
  assert.equal(await readFile(join(f.cwd, 'old.txt'), 'utf8'), 'external create');
});

test('cancellation and duplicate execution cannot leak a prepared lock or write twice', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const first = await f.filesystem.prepareMutation(f.call(controller.signal));
  const waitingController = new AbortController();
  const waiting = f.filesystem.prepareMutation(f.call(waitingController.signal));
  waitingController.abort(new Error('cancel waiting'));
  await assert.rejects(waiting, /cancel waiting/);
  controller.abort(new Error('cancel prepared'));
  await assert.rejects(first.execute(), /already settled/);
  first.cancel();
  const next = await f.filesystem.prepareMutation(f.call());
  await next.execute();
  await writeFile(f.path, 'later edit');
  await assert.rejects(next.execute(), /already settled/);
  next.cancel();
  assert.equal(await readFile(f.path, 'utf8'), 'later edit');
});

test('a failed preparation worker releases the lock without dispatching a write', async (t) => {
  const f = await fixture(t);
  const operations: string[] = [];
  const filesystem = createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    worker: {
      execute: async ({ operation }) => {
        operations.push(operation.kind);
        throw new Error('worker died');
      },
    },
  });
  const call = f.call();
  // The embedding default routes to its configured worker.
  const { executionBoundary: _boundary, ...workerCall } = call;
  await assert.rejects(filesystem.prepareMutation(workerCall), /worker died/);
  assert.deepEqual(operations, ['prepare_write']);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  const next = await f.filesystem.prepareMutation(f.call());
  next.cancel();
});

test('prepared and ordinary local Write retain identical result shapes', async (t) => {
  const f = await fixture(t);
  for (const previous of ['', 'before', 'new', 'unknown']) {
    await writeFile(f.path, previous);
    const prepared = await f.filesystem.prepareMutation(f.call());
    const result = await prepared.execute();
    await writeFile(f.path, previous);
    assert.deepEqual(await f.filesystem.execute(f.call()), result);
  }
  const call = f.call();
  call.operation.path = join(f.cwd, 'image.png');
  await writeFile(call.operation.path, 'text with an image extension');
  const prepared = await f.filesystem.prepareMutation(call);
  const result = await prepared.execute();
  assert.equal(result.kind === 'write' && result.diff, undefined);
});

test('prepared Edit keeps exact and fuzzy production results and rejects ambiguous matches before writing', async (t) => {
  const f = await fixture(t, 'edit');
  for (const [source, oldString, newString, matchedVia] of [
    ['before\n', 'before', 'after', 'exact'],
    ['  first line\n  second line\n', 'first line\nsecond line', 'new text', 'line-trimmed'],
    ['const value = 1;\n', 'const   value = 1;', 'const value = 2;', 'whitespace'],
    ['line1\nline2', 'line1\\nline2', 'next', 'escape'],
  ] as const) {
    const call = {
      ...f.call(),
      operation: {
        kind: 'edit' as const,
        path: f.path,
        oldString: oldString!,
        newString: newString!,
      },
    };
    await writeFile(f.path, source!);
    const prepared = await f.filesystem.prepareMutation(call);
    assert.equal(await readFile(f.path, 'utf8'), source);
    const result = await prepared.execute();
    assert.equal(result.kind, 'edit');
    if (result.kind === 'edit') assert.equal(result.matchedVia, matchedVia);
    const after = await readFile(f.path, 'utf8');
    await writeFile(f.path, source!);
    assert.deepEqual(await f.filesystem.execute(call), result);
    assert.equal(await readFile(f.path, 'utf8'), after);
  }
  await writeFile(f.path, 'before before');
  const ambiguous = await f.filesystem.prepareMutation(f.call());
  await assert.rejects(ambiguous.execute(), /not unique/);
  assert.equal(await readFile(f.path, 'utf8'), 'before before');
});

test('Edit cancellation, identity substitution and duplicate execution preserve outside content', async (t) => {
  const f = await fixture(t, 'edit');
  await writeFile(f.path, 'before\n');
  const controller = new AbortController();
  const cancelled = await f.filesystem.prepareMutation(f.call(controller.signal));
  controller.abort();
  await assert.rejects(cancelled.execute(), /already settled/);
  const replaced = await f.filesystem.prepareMutation(f.call());
  await rename(f.path, join(f.cwd, 'original'));
  await writeFile(f.path, 'before\n');
  await assert.rejects(replaced.execute(), /changed/);
  assert.equal(await readFile(f.path, 'utf8'), 'before\n');
  const once = await f.filesystem.prepareMutation(f.call());
  await once.execute();
  await writeFile(f.path, 'outside');
  await assert.rejects(once.execute(), /already settled/);
  assert.equal(await readFile(f.path, 'utf8'), 'outside');
});

test('input eligibility preserves UTF-8 byte limits for both mutation kinds', () => {
  const boundary = 'é'.repeat(FILE_MUTATION_MAX_BYTES / 2);
  for (const [content, eligible] of [
    [boundary, true],
    [boundary + 'x', false],
    ['\ud800', false],
  ] as const) {
    assert.equal(fileMutationInputEligible({ kind: 'write', content }), eligible);
    assert.equal(
      fileMutationInputEligible({ kind: 'edit', oldString: content, newString: 'after' }),
      eligible,
    );
    assert.equal(
      fileMutationInputEligible({ kind: 'edit', oldString: 'before', newString: content }),
      eligible,
    );
  }
});

for (const kind of ['write', 'edit'] as const) {
  test(`${kind}: ineligible input keeps ordinary execution after content changes`, async (t) => {
    const f = await fixture(t, kind);
    await writeFile(f.path, 'before\n');
    const content = 'x'.repeat(FILE_MUTATION_MAX_BYTES + 1);
    const call = {
      ...f.call(),
      operation:
        kind === 'write'
          ? { kind, path: f.path, content }
          : { kind, path: f.path, oldString: 'before', newString: content },
    };
    const prepared = await f.filesystem.prepareMutation(call);
    await writeFile(f.path, 'before external\n');
    const result = await prepared.execute();
    assert.equal(
      await readFile(f.path, 'utf8'),
      kind === 'write' ? content : content + ' external\n',
    );
    await writeFile(f.path, 'before external\n');
    assert.deepEqual(await f.filesystem.execute(call), result);
  });
}

test('invalid UTF-8, oversized content, and unsupported executor guards stay conservative', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, Buffer.from([0xff, 0xfe]));
  assert.equal(
    await prepareFileMutation(f.cwd, f.path, { kind: 'write', eligible: true }),
    undefined,
  );
  assert.equal(
    await prepareFileMutation(f.cwd, f.path, {
      kind: 'write',
      eligible: fileMutationInputEligible({
        kind: 'write',
        content: 'a'.repeat(FILE_MUTATION_MAX_BYTES + 1),
      }),
    }),
    undefined,
  );
  const prepared = await f.filesystem.prepareMutation(f.call());
  await prepared.execute();
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
  const unsupported = createBoundaryFilesystemExecutor({
    workspace: Object.assign(createLocalWorkspaceExecutor(), {
      prepareMutation: undefined,
      executePreparedMutation: undefined,
    }),
  });
  const fallback = await unsupported.prepareMutation(f.call());
  await fallback.execute();
});

for (const kind of ['write', 'edit'] as const) {
  test(`${kind}: external same-inode edit after T1 is rejected without truncation`, async (t) => {
    const f = await fixture(t, kind);
    await writeFile(f.path, 'before\n');
    const before = await lstat(f.path, { bigint: true });
    const result = await f.execute({
      commitToolPrepared: async (input) => {
        const committed = await f.store.commitToolPrepared(input);
        await writeFile(f.path, 'outside\n');
        const after = await lstat(f.path, { bigint: true });
        assert.equal(after.ino, before.ino);
        return committed;
      },
      commitToolOutcome: (input) => f.store.commitToolOutcome(input),
    });
    assert.match(JSON.stringify(result), /prepared file mutation target changed/);
    assert.equal(await readFile(f.path, 'utf8'), 'outside\n');
    const next = await f.filesystem.prepareMutation(f.call());
    next.cancel();
  });

  test(`${kind}: successful dispatch persists ordinary T1 only`, async (t) => {
    const f = await fixture(t, kind);
    await writeFile(f.path, 'before\n');
    let dispatched: ToolPreparedCommit | undefined;
    await f.execute({
      commitToolPrepared: async (input) => {
        dispatched = input;
        assert.equal(await readFile(f.path, 'utf8'), 'before\n');
        return f.store.commitToolPrepared(input);
      },
      commitToolOutcome: (input) => f.store.commitToolOutcome(input),
    });
    assert.ok(dispatched);
    const dispatch = dispatched.dispatchRuntimeEvent.actions?.toolDispatch;
    assert.ok(dispatch);
    assert.deepEqual(
      Object.keys(dispatch).sort(),
      [
        'protocol',
        'resultProjectionVersion',
        'operationId',
        'providerToolCallId',
        'toolName',
        'canonicalArgsHash',
        'recoveryMode',
      ].sort(),
    );
    assert.equal(dispatch.recoveryMode, 'never_auto_retry');
    assert.equal(await readFile(f.path, 'utf8'), 'after\n');
  });

  test(`${kind}: T1 failure leaves the target intact and releases its lock`, async (t) => {
    const f = await fixture(t, kind);
    await writeFile(f.path, 'before\n');
    await assert.rejects(
      f.execute({
        commitToolPrepared: async () => {
          throw new Error('T1 failed');
        },
        commitToolOutcome: (input) => f.store.commitToolOutcome(input),
      }),
      /T1 failed/,
    );
    assert.equal(await readFile(f.path, 'utf8'), 'before\n');
    const next = await f.filesystem.prepareMutation(f.call());
    await next.execute();
    assert.equal(await readFile(f.path, 'utf8'), 'after\n');
  });
}

for (const kind of ['write', 'edit'] as const) {
  test(`${kind}: prepared execution hides its guard and isolates caller/backend objects`, async (t) => {
    const f = await fixture(t, kind);
    await writeFile(f.path, 'before\n');
    const workspace = new LocalWorkspaceExecutor();
    const prepare = workspace.prepareMutation.bind(workspace);
    let backendGuard: FileMutationGuard | undefined;
    const filesystem = createBoundaryFilesystemExecutor({
      workspace: Object.assign(workspace, {
        prepareMutation: async (...args: Parameters<typeof prepare>) => {
          backendGuard = await prepare(...args);
          return backendGuard;
        },
      }),
    });
    const call = f.call();
    const prepared = await filesystem.prepareMutation(call);
    assert.deepEqual(Object.keys(prepared).sort(), ['cancel', 'execute']);
    assert.ok(backendGuard);
    backendGuard.target.path = join(f.cwd, 'wrong.txt');
    call.operation.path = join(f.cwd, 'wrong.txt');
    if (call.operation.kind === 'write') call.operation.content = 'wrong';
    else call.operation.newString = 'wrong';
    await prepared.execute();
    assert.equal(await readFile(f.path, 'utf8'), 'after\n');
    await assert.rejects(readFile(join(f.cwd, 'wrong.txt')), { code: 'ENOENT' });
  });
}

test('parent replacement is rejected without touching the replacement file', async (t) => {
  const f = await fixture(t);
  const parent = join(f.cwd, 'parent');
  await mkdir(parent);
  const path = join(parent, 'notes.txt');
  await writeFile(path, 'before');
  const prepared = await f.filesystem.prepareMutation({
    ...f.call(),
    operation: { kind: 'write', path, content: 'after' },
  });
  await rename(parent, join(f.cwd, 'old-parent'));
  await mkdir(parent);
  await writeFile(path, 'outside');
  await assert.rejects(prepared.execute(), /changed/);
  assert.equal(await readFile(path, 'utf8'), 'outside');
  assert.equal(await readFile(join(f.cwd, 'old-parent', 'notes.txt'), 'utf8'), 'before');
});

test('guard shape rejects legacy evidence and cross-tool reuse before mutation', async (t) => {
  const f = await fixture(t);
  const guard = await prepareFileMutation(f.cwd, f.path, { kind: 'write', eligible: true });
  assert.ok(guard);
  assert.equal(
    FileMutationGuardSchema.safeParse({ ...guard, after: { bytes: 5, digest: 'unused' } }).success,
    false,
  );
  await assert.rejects(
    executePreparedFileMutation(
      f.cwd,
      f.path,
      { kind: 'edit', oldString: 'before', newString: 'after' },
      guard,
    ),
    /changed/,
  );
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

for (const kind of ['write', 'edit'] as const) {
  test(`${kind}: real worker checks transient guards and rejects prior wire versions`, async (t) => {
    const f = await fixture(t, kind);
    await writeFile(f.path, 'before\n');
    const metadata = await lstat(f.path, { bigint: true });
    const operation =
      kind === 'write'
        ? { kind, path: f.path, cwd: f.cwd, content: 'after\n' }
        : { kind, path: f.path, cwd: f.cwd, oldString: 'before', newString: 'after' };
    const request = {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'guard-worker',
      operation,
      operationBoundary: {
        filesystem: { entries: [{ path: f.path, access: 'write', scope: 'exact' }] },
      },
      expectedTarget: {
        enforcementPath: f.path,
        access: 'write',
        scope: 'exact',
        targetType: 'file',
        identity: { dev: String(metadata.dev), ino: String(metadata.ino) },
      },
    };
    const run = async (body: unknown) => {
      const result = await runFilesystemWorkerProcess({
        argv: [
          process.execPath,
          fileURLToPath(new URL('../filesystem-worker/worker-entry.js', import.meta.url)),
        ],
        cwd: f.cwd,
        env: process.env,
        stdin: JSON.stringify(body),
      });
      assert.equal(result.exitCode, 0, result.stderrTail);
      return parseFilesystemWorkerResponse(JSON.parse(result.stdout));
    };
    const preparationOperation = {
      kind: kind === 'write' ? 'prepare_write' : 'prepare_edit',
      path: f.path,
      cwd: f.cwd,
      eligible: true,
    };
    const declined = await run({
      ...request,
      operation: { ...preparationOperation, eligible: false },
    });
    assert.ok(
      declined.ok &&
        (declined.result.kind === 'prepare_write' || declined.result.kind === 'prepare_edit'),
    );
    assert.equal(declined.result.guard, undefined);
    const deniedCwd = join(f.cwd, 'restricted');
    await mkdir(deniedCwd);
    const denied = await run({
      ...request,
      operation: { ...preparationOperation, cwd: deniedCwd, eligible: false },
      operationBoundary: {
        filesystem: { entries: [{ path: f.path, access: 'read', scope: 'exact' }] },
      },
    });
    assert.ok(!denied.ok && denied.error.code === 'path_denied');
    const payloadRejected = await run({
      ...request,
      operation: { ...operation, ...preparationOperation },
    });
    assert.ok(!payloadRejected.ok && payloadRejected.error.code === 'invalid_request');
    assert.equal(await readFile(f.path, 'utf8'), 'before\n');
    const prepared = await run({ ...request, operation: preparationOperation });
    assert.ok(
      prepared.ok &&
        (prepared.result.kind === 'prepare_write' || prepared.result.kind === 'prepare_edit') &&
        prepared.result.guard,
    );
    const guard = prepared.result.guard;
    assert.equal(await readFile(f.path, 'utf8'), 'before\n');
    assert.equal('result' in guard, false);
    assert.equal('after' in guard, false);
    for (const version of [12, 13, 14]) {
      const legacy = await run({ ...request, version, operation: { ...operation, guard } });
      assert.equal(legacy.ok, false);
    }
    assert.equal(await readFile(f.path, 'utf8'), 'before\n');
    await writeFile(f.path, 'outside\n');
    const rejected = await run({ ...request, operation: { ...operation, guard } });
    assert.ok(!rejected.ok && rejected.error.code === 'path_changed');
    assert.equal(await readFile(f.path, 'utf8'), 'outside\n');
    await writeFile(f.path, 'before\n');
    const executed = await run({ ...request, operation: { ...operation, guard } });
    assert.ok(executed.ok);
    assert.equal(await readFile(f.path, 'utf8'), 'after\n');
    if (kind === 'edit') {
      for (const [name, content, message] of [
        ['missing match', 'unrelated text', /not found/],
        ['ambiguous match', 'before before', /not unique/],
      ] as const) {
        await t.test(`preserves ${name} as an actionable edit conflict`, async () => {
          await writeFile(f.path, content);
          const preparation = await run({
            ...request,
            operation: { kind: 'prepare_edit', path: f.path, cwd: f.cwd, eligible: true },
          });
          assert.ok(preparation.ok && preparation.result.kind === 'prepare_edit');
          assert.ok(preparation.result.guard);
          const ordinary = await run(request);
          const guarded = await run({
            ...request,
            operation: { ...operation, guard: preparation.result.guard },
          });
          assert.ok(!ordinary.ok && ordinary.error.code === 'edit_conflict');
          assert.match(ordinary.error.message, message);
          assert.ok(!guarded.ok);
          assert.deepEqual(guarded.error, ordinary.error);
          assert.equal(await readFile(f.path, 'utf8'), content);
        });
      }
    }
  });
}
