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

// Verify that a filesystem mutation whose worker fails after dispatch is
// surfaced as an unknown outcome, while pre-flight failures and read failures
// pass through as ordinary errors. This is the host-side half of issue #2600's
// "post-dispatch unknown outcomes"; the worker-side dispatch flag is exercised
// separately in filesystem-worker-client.test.ts.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { ToolOutcomeUnknownError } from '@maka/core/events';

import { createBoundaryFilesystemExecutor } from '../filesystem-executor.js';
import {
  FilesystemWorkerClientError,
  type FilesystemWorkerClient,
  type FilesystemWorkerClientErrorReason,
  type FilesystemWorkerExecuteInput,
} from '../filesystem-worker/client.js';
import type { FilesystemWorkerResult } from '../filesystem-worker/protocol.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A worker whose execute always rejects with a configured client error. */
function failingWorker(
  reason: FilesystemWorkerClientErrorReason,
  dispatched?: boolean,
): { execute: () => Promise<FilesystemWorkerResult> } {
  return {
    async execute(): Promise<FilesystemWorkerResult> {
      throw new FilesystemWorkerClientError({
        reason,
        stage: 'launch',
        requestId: 'test',
        ...(dispatched !== undefined ? { dispatched } : {}),
      });
    },
  };
}

function executorWith(worker: {
  execute: (input: FilesystemWorkerExecuteInput) => Promise<FilesystemWorkerResult>;
}) {
  return createBoundaryFilesystemExecutor({
    workspace: createLocalWorkspaceExecutor(),
    worker: worker as Pick<FilesystemWorkerClient, 'execute'>,
  });
}

describe('filesystem mutation unknown-outcome classification', () => {
  // Launch-stage reasons: the child ran. These carry dispatched:true on the
  // real error object (the process-runner / client set it), and the filter
  // treats membership in UNKNOWN_OUTCOME_REASONS as sufficient.
  const launchStageReasons: FilesystemWorkerClientErrorReason[] = [
    'worker_crashed',
    'worker_io_incomplete',
    'timeout',
    'response_overflow',
  ];
  for (const reason of launchStageReasons) {
    test(`Write failing with ${reason} (dispatched) becomes an unknown outcome`, async () => {
      const fs = executorWith(failingWorker(reason, true));
      await assert.rejects(
        fs.execute({
          operation: { kind: 'write', path: '/tmp/maka-outcome-write.txt', content: 'x' },
          cwd: '/tmp',
        }),
        (error: unknown) => {
          assert.ok(error instanceof ToolOutcomeUnknownError, `${reason} should convert`);
          assert.ok(
            error.cause instanceof FilesystemWorkerClientError,
            'cause should be the original worker error',
          );
          return true;
        },
      );
    });
  }

  // Protocol-stage reasons: these arrive from the worker-response branch in
  // client.ts, which sets dispatched:true explicitly. The filter must still
  // convert them even if some future change leaves dispatched unset, because
  // these reasons are *semantically* dispatched (the child answered). We do
  // NOT pass dispatched in the fixture to prove membership alone suffices.
  const protocolStageReasons: FilesystemWorkerClientErrorReason[] = [
    'invalid_response',
    'response_id_mismatch',
    'response_kind_mismatch',
    'outcome_unknown',
  ];
  for (const reason of protocolStageReasons) {
    test(`Write failing with ${reason} converts regardless of dispatched flag`, async () => {
      // Real path: the worker-response branch sets dispatched:true. Here we
      // exercise the stronger guarantee — the reason alone is sufficient.
      const fs = executorWith(failingWorker(reason, undefined));
      await assert.rejects(
        fs.execute({
          operation: { kind: 'write', path: `/tmp/maka-outcome-${reason}.txt`, content: 'x' },
          cwd: '/tmp',
        }),
        (error: unknown) => error instanceof ToolOutcomeUnknownError,
      );
    });
  }

  test('Write failing with spawn_failed (never dispatched) is NOT an unknown outcome', async () => {
    const fs = executorWith(failingWorker('spawn_failed', false));
    await assert.rejects(
      fs.execute({
        operation: { kind: 'write', path: '/tmp/maka-outcome-spawn.txt', content: 'x' },
        cwd: '/tmp',
      }),
      (error: unknown) => {
        // spawn_failed means the child never started: nothing could have been
        // written, so it must surface as a plain error, not unknown outcome.
        assert.ok(!(error instanceof ToolOutcomeUnknownError));
        assert.ok(error instanceof FilesystemWorkerClientError);
        return true;
      },
    );
  });

  test('an aborted mutation before dispatch is a clean cancel, not unknown', async () => {
    const fs = executorWith(failingWorker('aborted', false));
    await assert.rejects(
      fs.execute({
        operation: { kind: 'write', path: '/tmp/maka-outcome-abort-pre.txt', content: 'x' },
        cwd: '/tmp',
      }),
      (error: unknown) => {
        assert.ok(!(error instanceof ToolOutcomeUnknownError));
        assert.ok(error instanceof FilesystemWorkerClientError);
        return true;
      },
    );
  });

  test('an aborted mutation after dispatch is an unknown outcome', async () => {
    const fs = executorWith(failingWorker('aborted', true));
    await assert.rejects(
      fs.execute({
        operation: { kind: 'write', path: '/tmp/maka-outcome-abort-post.txt', content: 'x' },
        cwd: '/tmp',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ToolOutcomeUnknownError);
        return true;
      },
    );
  });

  test('apply_patch (delete) failing after dispatch becomes an unknown outcome', async () => {
    const fs = executorWith(failingWorker('worker_crashed', true));
    await assert.rejects(
      fs.applyPatch({
        operation: { type: 'delete_file', path: '/tmp/maka-outcome-delete.txt' },
        cwd: '/tmp',
      }),
      (error: unknown) => error instanceof ToolOutcomeUnknownError,
    );
  });

  test('a validation-stage failure is NOT an unknown outcome', async () => {
    // Pre-flight validation failures (e.g. invalid_request) happen before any
    // dispatch, so they can never have mutated the file.
    const worker = {
      async execute(): Promise<FilesystemWorkerResult> {
        throw new FilesystemWorkerClientError({
          reason: 'invalid_request',
          stage: 'validation',
          requestId: 'test',
        });
      },
    };
    const fs = executorWith(worker);
    await assert.rejects(
      fs.execute({
        operation: { kind: 'write', path: '/tmp/maka-outcome-validation.txt', content: 'x' },
        cwd: '/tmp',
      }),
      (error: unknown) => {
        assert.ok(!(error instanceof ToolOutcomeUnknownError));
        return true;
      },
    );
  });
});

describe('filesystem mutation T0 identity capture (queue-window closure)', () => {
  // This is the red-line test for issue #2600 concern #1. The identity must be
  // captured at lock acquisition (T0), BEFORE waiting for the write lock — not
  // re-derived after the lock is granted (T1). To prove that, the test must
  // exercise a REAL lock wait: a first mutation blocks inside the worker while
  // holding the path's lock, a second mutation queues behind it, and the path
  // is replaced while the second one waits. A regression that captures the
  // identity at T1 (after the lock is granted) then samples the replacement's
  // inode and this test fails; a T0 capture still sees the original inode.
  test('a queued mutation receives the pre-replacement identity captured at lock acquisition', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-t0-lockwait-')));
    cleanup.push(cwd);
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');

    const original = await stat(target, { bigint: true });

    // The first mutation blocks inside the worker, holding the write lock.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    let queuedIdentity: { dev: string; ino: string } | undefined;
    const gatedWorker: {
      execute: (input: FilesystemWorkerExecuteInput) => Promise<FilesystemWorkerResult>;
    } = {
      async execute(input) {
        calls += 1;
        if (calls === 1) {
          await firstGate; // hold the path's lock until the swap has happened
          return { kind: 'write', ok: true, path: target, bytes: 5 };
        }
        // The queued (second) call: record the identity it was handed.
        queuedIdentity = input.expectedIdentity;
        return { kind: 'write', ok: true, path: target, bytes: 6 };
      },
    };
    const fs = executorWith(gatedWorker);

    // First mutation: acquires the lock and blocks inside the worker.
    const first = fs.execute({
      operation: { kind: 'write', path: target, content: 'first' },
      cwd,
    });
    await sleep(50); // let the first call reach the worker and hold the lock

    // Second mutation: captures its identity (T0) and queues on the lock.
    const second = fs.execute({
      operation: { kind: 'write', path: target, content: 'second' },
      cwd,
    });
    await sleep(50); // let the second call finish its T0 capture and queue

    // Replace the path WHILE the second mutation is still waiting for the lock.
    await rename(replacement, target);

    // Release the first mutation; the second acquires the lock and dispatches
    // with whatever identity its capture step sampled.
    releaseFirst();
    await Promise.all([first, second]);

    assert.ok(queuedIdentity, 'the queued mutation should have dispatched to the worker');
    assert.equal(
      queuedIdentity.ino,
      String(original.ino),
      'identity must be the inode captured at lock acquisition (before the replacement); a T1 capture would sample the replacement',
    );
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
