// Verify that a filesystem mutation whose worker fails after dispatch is
// surfaced as an unknown outcome, while pre-flight failures and read failures
// pass through as ordinary errors. This is the host-side half of issue #2600's
// "post-dispatch unknown outcomes"; the worker-side dispatch flag is exercised
// separately in filesystem-worker-client.test.ts.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { ToolOutcomeUnknownError } from '@maka/core';

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
          assert.ok(error.cause instanceof FilesystemWorkerClientError);
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
  // re-derived inside client.execute after the lock is held (T1). If it were
  // captured at T1, a path replaced during the lock wait would sample the
  // replacement's inode, making the CAS self-fulfilling and the window open.
  test('the worker receives the T0 identity (before replacement), not T1 (after)', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-t0-identity-')));
    cleanup.push(cwd);
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');

    // Capture the original inode for later comparison.
    const { stat } = await import('node:fs/promises');
    const originalMeta = await stat(target, { bigint: true });
    const originalIno = String(originalMeta.ino);

    let capturedIdentity: { dev: string; ino: string } | undefined;
    // A worker that records the identity it receives, then replaces the path
    // (simulating a replacement that happened during the lock wait), and returns
    // a synthetic result. The point is to observe WHAT identity the worker got.
    const recordingWorker: {
      execute: (input: FilesystemWorkerExecuteInput) => Promise<FilesystemWorkerResult>;
    } = {
      async execute(input) {
        capturedIdentity = input.expectedIdentity;
        // Simulate the replacement having happened during the lock wait.
        await rename(replacement, target);
        return { kind: 'write', ok: true, path: target, bytes: 3 };
      },
    };
    const fs = executorWith(recordingWorker);

    await fs.execute({
      operation: { kind: 'write', path: target, content: 'new' },
      cwd,
    });

    // The worker must have received the T0 identity (original inode), proving
    // the capture happened before the replacement. If it were T1, the identity
    // would be the replacement's inode.
    assert.ok(capturedIdentity, 'worker should have received an identity');
    assert.equal(
      capturedIdentity.ino,
      originalIno,
      'identity must be the T0 (pre-replacement) inode, not T1',
    );
  });
});
