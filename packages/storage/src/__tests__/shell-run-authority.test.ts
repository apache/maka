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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { ShellRunRecord } from '@maka/core/shell-run';
import {
  authenticateInteractiveShellRunWriter,
  openInteractiveShellRunStoreForWrite,
  type InteractiveShellRunWriter,
} from '../shell-run-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

describe('interactive ShellRun authority', () => {
  test('single-flights one authentic writer and preserves durable lifecycle state', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const [first, second] = await Promise.all([
          openInteractiveShellRunStoreForWrite(owner.lease),
          openInteractiveShellRunStoreForWrite(owner.lease),
        ]);
        assert.equal(first, second);
        assert.equal(authenticateInteractiveShellRunWriter(first), first);

        const input = record();
        const createdPromise = first.createShellRun(input);
        if (input.output.mode !== 'pipes') assert.fail('Expected pipe output fixture');
        input.output.stdout = 'mutated after acceptance';
        const created = await createdPromise;
        assert.equal(created.output.mode === 'pipes' ? created.output.stdout : undefined, '');

        const completed = await second.updateShellRun('session-1', 'shell-1', {
          status: 'completed',
          exitCode: 0,
          completedAt: 2,
          updatedAt: 2,
          output: pipeOutput('done'),
        });
        assert.equal(completed.status, 'completed');
        assert.equal(completed.revision, 2);

        first.close();
        assert.throws(() => authenticateInteractiveShellRunWriter(first), isInvalidLease);
        const reopened = await openInteractiveShellRunStoreForWrite(owner.lease);
        assert.notEqual(reopened, first);
        assert.equal((await reopened.readShellRun('session-1', 'shell-1')).status, 'completed');
        reopened.close();
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects reads and mutations after its owner lease is released', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveShellRunStoreForWrite(owner.lease);
      await writer.createShellRun(record());
      await owner.close();

      await assert.rejects(() => writer.readShellRun('session-1', 'shell-1'), isInvalidLease);
      await assert.rejects(
        () => writer.updateShellRun('session-1', 'shell-1', { updatedAt: 2 }),
        isInvalidLease,
      );
      writer.close();
    });
  });

  test('rejects forged leases and forged writer facades', async () => {
    await assert.rejects(
      () => openInteractiveShellRunStoreForWrite({} as StorageRootLease<'interactive', 'write'>),
      isInvalidLease,
    );

    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveShellRunStoreForWrite(owner.lease);
      try {
        assert.throws(
          () =>
            authenticateInteractiveShellRunWriter({
              ...writer,
            } as InteractiveShellRunWriter),
          isInvalidLease,
        );
      } finally {
        writer.close();
        await owner.close();
      }
    });
  });
});

function record(): ShellRunRecord {
  return {
    shellRunId: 'shell-1',
    sessionId: 'session-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: 'printf done',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: pipeOutput(''),
  };
}

function pipeOutput(stdout: string): Extract<ShellRunRecord['output'], { mode: 'pipes' }> {
  return {
    mode: 'pipes',
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

async function withInteractiveRoot(
  run: (input: {
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (base) => {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: join(base, 'interactive'), kind: 'interactive' }),
    );
    await run({ capability });
  });
}

async function withTempDir(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-shell-run-authority-'));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
