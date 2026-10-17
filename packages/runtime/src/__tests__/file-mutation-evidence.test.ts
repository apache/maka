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
import { mkdtemp, readFile, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import {
  isFileMutationEvidence,
  fileEvidenceDigest,
  FILE_WRITE_EVIDENCE_CONTRACT,
  FILE_EDIT_EVIDENCE_CONTRACT,
} from '@maka/core/file-mutation-evidence';
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeCommitSink, ToolPreparedCommit } from '../runtime-commit-sink.js';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';
import { createBoundaryFilesystemExecutor } from '../filesystem-executor.js';
import {
  executePreparedFileWrite,
  prepareFileWrite,
  prepareFileMutation,
  executePreparedFileMutation,
} from '../file-mutation-evidence.js';
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

for (const existing of [false, true]) {
  test(`T1 failure leaves ${existing ? 'existing' : 'missing'} file untouched and releases the lock`, async (t) => {
    const f = await fixture(t);
    if (existing) await writeFile(f.path, 'before\n');
    let prepared: ToolPreparedCommit | undefined;
    await assert.rejects(
      f.execute({
        commitToolPrepared: async (input) => {
          prepared = input;
          throw new Error('T1 unavailable');
        },
        commitToolOutcome: async () => {
          throw new Error('must not reach T2');
        },
      }),
      /T1 unavailable/,
    );
    assert.ok(
      isFileMutationEvidence(
        prepared?.dispatchRuntimeEvent.actions?.toolDispatch?.fileMutationEvidence,
      ),
    );
    if (existing) assert.equal(await readFile(f.path, 'utf8'), 'before\n');
    else await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    assert.deepEqual(await f.store.readRuntimeEvents('session-1', 'run-1'), []);
    const retry = await f.filesystem.prepareMutation(f.call());
    retry.cancel();
  });
}

test('ordinary Write persists bound evidence and keeps the production diff', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, 'before\n');
  const expected = await prepareFileWrite(f.cwd, f.path, 'after\n');
  assert.ok(expected);
  const settled = await f.execute({
    commitToolPrepared: async (input) => {
      assert.equal(await readFile(f.path, 'utf8'), 'before\n');
      return f.store.commitToolPrepared(input);
    },
    commitToolOutcome: (input) => f.store.commitToolOutcome(input),
  });
  assert.deepEqual(settled.result, {
    kind: 'file_diff',
    paths: [f.path],
    diff: expected.result.diff,
  });
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
  const events = await f.store.readRuntimeEvents('session-1', 'run-1');
  const dispatch = events.find((event) => event.actions?.toolDispatch)!;
  const evidence = dispatch.actions!.toolDispatch!.fileMutationEvidence!;
  assert.ok(isFileMutationEvidence(evidence));
  assert.equal(evidence.binding.dispatchEventId, dispatch.id);
  assert.equal(
    evidence.binding.canonicalArgsHash,
    dispatch.actions!.toolDispatch!.canonicalArgsHash,
  );
  assert.equal(dispatch.actions!.toolDispatch!.recoveryMode, 'never_auto_retry');
  assert.ok(events.some((event) => event.content?.kind === 'function_response'));
});

for (const point of ['after_runtime_event_insert', 'after_journal_event_insert'] as const) {
  test(`SQLite rolls evidence and T1 back together at ${point}`, async (t) => {
    const f = await fixture(t);
    const dbPath = join(f.cwd, 'fault.sqlite');
    const broken = createSqliteRuntimeStore(dbPath, {
      failpoint: (reached) => {
        if (reached === point) throw new Error(`T1 failpoint ${point}`);
      },
    });
    try {
      await assert.rejects(f.execute(broken), /T1 failpoint/);
      assert.deepEqual(await broken.readRuntimeEvents('session-1', 'run-1'), []);
      await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    } finally {
      broken.close();
    }
    const reopened = createSqliteRuntimeStore(dbPath);
    try {
      assert.deepEqual(await reopened.readRuntimeEvents('session-1', 'run-1'), []);
    } finally {
      reopened.close();
    }
    const next = await f.filesystem.prepareMutation(f.call());
    next.cancel();
  });
}

for (const point of ['after_t1', 'before_t2'] as const) {
  test(`reopen retains evidence after a simulated crash ${point}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.execute({
        commitToolPrepared: async (input) => {
          const committed = await f.store.commitToolPrepared(input);
          if (point === 'after_t1') throw new Error('simulated crash after T1');
          return committed;
        },
        commitToolOutcome: async () => {
          throw new Error('simulated crash before T2');
        },
      }),
      /simulated crash/,
    );
    if (point === 'after_t1') await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    else assert.equal(await readFile(f.path, 'utf8'), 'after\n');
    f.store.close();
    const reopened = createSqliteRuntimeStore(f.dbPath);
    try {
      await reopened.rebuildToolProjectionsFromRuntimeEvents();
      const events = await reopened.readRuntimeEvents('session-1', 'run-1');
      const dispatch = events.find((event) => event.actions?.toolDispatch)!;
      assert.ok(isFileMutationEvidence(dispatch.actions!.toolDispatch!.fileMutationEvidence));
      assert.equal(
        (await reopened.readToolOperation(dispatch.actions!.toolDispatch!.operationId))
          ?.currentState,
        'prepared',
      );
      assert.ok(!events.some((event) => event.content?.kind === 'function_response'));
    } finally {
      reopened.close();
    }
    const next = await f.filesystem.prepareMutation(f.call());
    next.cancel();
  });
}

test('an in-place external edit after T1 is rejected before truncation', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, 'before\n');
  const result = await f.execute({
    commitToolPrepared: async (input) => {
      const committed = await f.store.commitToolPrepared(input);
      await writeFile(f.path, 'external edit\n');
      return committed;
    },
    commitToolOutcome: (input) => f.store.commitToolOutcome(input),
  });
  assert.match(JSON.stringify(result), /prepared file mutation target changed/);
  assert.equal(await readFile(f.path, 'utf8'), 'external edit\n');
});

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

test('observation and caller argument mutation cannot change the prepared execution', async (t) => {
  const f = await fixture(t);
  const call = f.call();
  const prepared = await f.filesystem.prepareMutation(call);
  assert.equal(call.operation.kind, 'write');
  if (call.operation.kind === 'write') call.operation.content = 'wrong';
  prepared.observation!.after.digest = `sha256:${'0'.repeat(64)}`;
  await prepared.execute();
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
});

test('invalid UTF-8, oversized content, and unsupported executor observations stay conservative', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, Buffer.from([0xff, 0xfe]));
  assert.equal(await prepareFileWrite(f.cwd, f.path, 'after'), undefined);
  assert.equal(
    await prepareFileWrite(
      f.cwd,
      f.path,
      'a'.repeat(FILE_WRITE_EVIDENCE_CONTRACT.maxFileBytes + 1),
    ),
    undefined,
  );
  const prepared = await f.filesystem.prepareMutation(f.call());
  assert.equal(prepared.observation, undefined);
  await prepared.execute();
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
  const unsupported = createBoundaryFilesystemExecutor({
    workspace: Object.assign(createLocalWorkspaceExecutor(), {
      prepareMutation: undefined,
      executePreparedMutation: undefined,
    }),
  });
  const fallback = await unsupported.prepareMutation(f.call());
  assert.equal(fallback.observation, undefined);
  await fallback.execute();
});

test('evidence tampering, contract drift and cross-operation substitution are rejected', async (t) => {
  const f = await fixture(t);
  let prepared!: ToolPreparedCommit;
  await assert.rejects(
    f.execute({
      commitToolPrepared: async (input) => {
        prepared = structuredClone(input);
        throw new Error('capture');
      },
      commitToolOutcome: async () => {
        throw new Error('unexpected T2');
      },
    }),
    /capture/,
  );
  for (const mutation of ['digest', 'version', 'binding'] as const) {
    const bad = structuredClone(prepared);
    const evidence = bad.dispatchRuntimeEvent.actions!.toolDispatch!.fileMutationEvidence!;
    if (mutation === 'digest') evidence.observation.after.bytes++;
    if (mutation === 'version') Object.assign(evidence.observation.contract, { version: 2 });
    if (mutation === 'binding') {
      evidence.binding.operationId = 'different-operation';
      evidence.digest = fileEvidenceDigest({
        observation: evidence.observation,
        binding: evidence.binding,
      });
    }
    assert.throws(() => decodeRuntimeEvent(bad.dispatchRuntimeEvent));
    await assert.rejects(f.store.commitToolPrepared(bad));
    assert.deepEqual(await f.store.readRuntimeEvents('session-1', 'run-1'), []);
  }
});

test('real one-shot worker prepares without creating and consumes the same observation on execution', async (t) => {
  const f = await fixture(t);
  const request = {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    // Deliberately differ from this process's directory inodes, as a Linux
    // worker's synthetic ancestors differ from the trusted host observation.
    hostDirectories: { workspace: { dev: '101', ino: '102' }, parent: { dev: '103', ino: '104' } },
    requestId: 'worker-prepare',
    operation: { kind: 'prepare_write', cwd: f.cwd, path: f.path, content: 'after\n' },
    operationBoundary: {
      filesystem: { entries: [{ path: f.path, access: 'write', scope: 'exact' }] },
    },
    expectedTarget: {
      enforcementPath: f.path,
      access: 'write',
      scope: 'exact',
      targetType: 'missing',
      identity: 'missing',
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
  const prepared = await run(request);
  assert.ok(prepared.ok && prepared.result.kind === 'prepare_write' && prepared.result.observation);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  const observation = prepared.result.observation;
  assert.deepEqual(observation.workspace.identity, request.hostDirectories.workspace);
  assert.deepEqual(observation.target.parentIdentity, request.hostDirectories.parent);
  const rejected = await run({
    ...request,
    hostDirectories: { ...request.hostDirectories, parent: { dev: '103', ino: '999' } },
    operation: { ...request.operation, kind: 'write', observation },
  });
  assert.ok(!rejected.ok && rejected.error.code === 'path_changed');
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  const executed = await run({
    ...request,
    requestId: 'worker-write',
    operation: { ...request.operation, kind: 'write', observation },
  });
  assert.ok(executed.ok);
  assert.deepEqual(executed.result, observation.result);
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
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
  assert.equal(prepared.observation, undefined);
  const result = await prepared.execute();
  assert.equal(result.kind === 'write' && result.diff, undefined);
});

test('prepared primitive refuses content substitution before creating a file', async (t) => {
  const f = await fixture(t);
  const observation = await prepareFileWrite(f.cwd, f.path, 'after\n');
  assert.ok(observation);
  await assert.rejects(
    executePreparedFileWrite(f.cwd, f.path, 'substitution', observation),
    /changed/,
  );
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

for (const point of ['fail_t1', 'after_t1', 'before_t2', 'external_change'] as const) {
  test(`Edit evidence survives ${point} without an unproven write`, async (t) => {
    const f = await fixture(t, 'edit');
    await writeFile(f.path, 'before\n');
    let prepared!: ToolPreparedCommit;
    const promise = f.execute({
      commitToolPrepared: async (input) => {
        prepared = structuredClone(input);
        assert.equal(await readFile(f.path, 'utf8'), 'before\n');
        assert.deepEqual(
          input.dispatchRuntimeEvent.actions?.toolDispatch?.fileMutationEvidence?.observation
            .contract,
          FILE_EDIT_EVIDENCE_CONTRACT,
        );
        if (point === 'fail_t1') throw new Error('injected failure');
        const result = await f.store.commitToolPrepared(input);
        if (point === 'after_t1') throw new Error('injected failure');
        if (point === 'external_change') await writeFile(f.path, 'outside\n');
        return result;
      },
      commitToolOutcome: async (input) => {
        if (point === 'before_t2') throw new Error('injected failure');
        return f.store.commitToolOutcome(input);
      },
    });
    if (point === 'external_change') assert.match(JSON.stringify(await promise), /target changed/);
    else await assert.rejects(promise, /injected failure/);
    assert.equal(
      await readFile(f.path, 'utf8'),
      point === 'before_t2' ? 'after\n' : point === 'external_change' ? 'outside\n' : 'before\n',
    );
    assert.ok(
      isFileMutationEvidence(
        prepared.dispatchRuntimeEvent.actions?.toolDispatch?.fileMutationEvidence,
      ),
    );
    f.store.close();
    const reopened = createSqliteRuntimeStore(f.dbPath);
    try {
      await reopened.rebuildToolProjectionsFromRuntimeEvents();
      const events = await reopened.readRuntimeEvents('session-1', 'run-1');
      if (point === 'fail_t1') assert.deepEqual(events, []);
      else {
        const dispatch = events.find((event) => event.actions?.toolDispatch)!;
        assert.ok(isFileMutationEvidence(dispatch.actions!.toolDispatch!.fileMutationEvidence));
        assert.equal(dispatch.actions!.toolDispatch!.recoveryMode, 'never_auto_retry');
      }
    } finally {
      reopened.close();
    }
    const retry = await f.filesystem.prepareMutation(f.call());
    retry.cancel();
  });
}

for (const point of ['after_runtime_event_insert', 'after_journal_event_insert'] as const) {
  test(`Edit evidence is rolled back atomically at ${point}`, async (t) => {
    const f = await fixture(t, 'edit');
    await writeFile(f.path, 'before\n');
    const broken = createSqliteRuntimeStore(join(f.cwd, 'fault.sqlite'), {
      failpoint: (reached) => {
        if (reached === point) throw new Error('T1 rollback');
      },
    });
    try {
      await assert.rejects(f.execute(broken), /T1 rollback/);
      assert.deepEqual(await broken.readRuntimeEvents('session-1', 'run-1'), []);
      assert.equal(await readFile(f.path, 'utf8'), 'before\n');
    } finally {
      broken.close();
    }
  });
}

test('prepared Edit keeps exact and fuzzy production results and rejects ambiguous matches', async (t) => {
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
    assert.ok(prepared.observation);
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
  assert.equal(ambiguous.observation, undefined);
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

test('Edit contracts reject missing prior state, tool substitution and unknown algorithms', async (t) => {
  const f = await fixture(t, 'edit');
  await writeFile(f.path, 'before\n');
  let prepared!: ToolPreparedCommit;
  await assert.rejects(
    f.execute({
      commitToolPrepared: async (input) => {
        prepared = structuredClone(input);
        throw new Error('capture');
      },
      commitToolOutcome: async () => {
        throw new Error('unexpected');
      },
    }),
    /capture/,
  );
  for (const change of ['missing', 'algorithm', 'tool', 'result'] as const) {
    const event = structuredClone(prepared.dispatchRuntimeEvent);
    const dispatch = event.actions!.toolDispatch!;
    const evidence = dispatch.fileMutationEvidence!;
    if (change === 'missing') evidence.observation.before = { kind: 'missing' };
    if (change === 'algorithm')
      Object.assign(evidence.observation.contract, { algorithm: 'unknown_v2' });
    if (change === 'tool') dispatch.toolName = 'Write';
    if (change === 'result') Object.assign(evidence.observation.result, { matchedVia: 'unknown' });
    evidence.digest = fileEvidenceDigest({
      observation: evidence.observation,
      binding: evidence.binding,
    });
    assert.throws(() => decodeRuntimeEvent(event));
  }
  // Historical dispatches without the optional new field remain decodable.
  const legacy = structuredClone(prepared.dispatchRuntimeEvent);
  delete legacy.actions!.toolDispatch!.fileMutationEvidence;
  assert.equal(decodeRuntimeEvent(legacy).id, legacy.id);
});

test('ordinary Edit persists evidence with T1 and publishes its production result at T2', async (t) => {
  const f = await fixture(t, 'edit');
  await writeFile(f.path, 'before\n');
  const expected = await prepareFileMutation(f.cwd, f.path, {
    kind: 'edit',
    oldString: 'before',
    newString: 'after',
  });
  assert.ok(expected);
  const settled = await f.execute();
  assert.deepEqual(settled.result, {
    kind: 'file_diff',
    paths: [f.path],
    diff: expected.result.diff,
  });
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
  const events = await f.store.readRuntimeEvents('session-1', 'run-1');
  const evidence = events.find((event) => event.actions?.toolDispatch)!.actions!.toolDispatch!
    .fileMutationEvidence!;
  assert.ok(isFileMutationEvidence(evidence));
  assert.equal(evidence.observation.result.kind, 'edit');
  assert.ok(events.some((event) => event.content?.kind === 'function_response'));
});

test('real one-shot worker prepares and executes Edit with the exact same result', async (t) => {
  const f = await fixture(t, 'edit');
  await writeFile(f.path, 'before\n');
  const metadata = await import('node:fs/promises').then((fs) => fs.stat(f.path, { bigint: true }));
  const request = {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId: 'edit-prepare',
    operation: {
      kind: 'prepare_edit',
      cwd: f.cwd,
      path: f.path,
      oldString: 'before',
      newString: 'after',
    },
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
  const prepared = await run(request);
  assert.ok(prepared.ok && prepared.result.kind === 'prepare_edit' && prepared.result.observation);
  const observation = prepared.result.observation;
  assert.equal(await readFile(f.path, 'utf8'), 'before\n');
  const bad = await run({
    ...request,
    operation: { ...request.operation, kind: 'edit', newString: 'wrong', observation },
  });
  assert.ok(!bad.ok && bad.error.code === 'path_changed');
  assert.equal(await readFile(f.path, 'utf8'), 'before\n');
  const executed = await run({
    ...request,
    operation: { ...request.operation, kind: 'edit', observation },
  });
  assert.ok(executed.ok);
  assert.deepEqual(executed.result, observation.result);
  assert.equal(await readFile(f.path, 'utf8'), 'after\n');
});

test('unsupported Edit evidence preserves legacy behavior without upgrading recovery', async (t) => {
  const f = await fixture(t, 'edit');
  const mutation = { kind: 'edit' as const, oldString: 'before', newString: 'after' };
  assert.equal(await prepareFileMutation(f.cwd, f.path, mutation), undefined);
  const missing = await f.filesystem.prepareMutation(f.call());
  await assert.rejects(missing.execute());
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await writeFile(f.path, Buffer.from([0xff, 0xfe]));
  assert.equal(await prepareFileMutation(f.cwd, f.path, mutation), undefined);
  await writeFile(f.path, 'before');
  assert.equal(
    await prepareFileMutation(f.cwd, f.path, {
      ...mutation,
      newString: 'x'.repeat(FILE_WRITE_EVIDENCE_CONTRACT.maxFileBytes + 1),
    }),
    undefined,
  );
  const observation = await prepareFileMutation(f.cwd, f.path, mutation);
  assert.ok(observation);
  await assert.rejects(
    executePreparedFileMutation(f.cwd, f.path, { ...mutation, newString: 'wrong' }, observation),
    /changed/,
  );
  assert.equal(await readFile(f.path, 'utf8'), 'before');
});
