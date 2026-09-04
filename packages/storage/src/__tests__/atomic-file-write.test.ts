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
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  AtomicFileWriteCommitUnknownError,
  writeAtomicFile,
  type AtomicFileWriteDependencies,
  type AtomicFileWriteHandle,
} from '../atomic-file-write.js';

const isPosix = process.platform !== 'win32';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-atomic-write-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('writeAtomicFile', () => {
  test('writes the exact bytes and leaves no temp file behind', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      await writeAtomicFile(path, '{"a":1}\n');
      assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
      assert.deepEqual(await readdir(dir), ['settings.json']);
    });
  });

  for (const failurePhase of ['write', 'sync', 'close'] as const) {
    test(`removes its temp file and rethrows after a ${failurePhase} failure`, async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'settings.json');
        const temporaryPath = `${path}.fault.tmp`;
        const fault = new Error(`${failurePhase} failed`);
        await assert.rejects(
          () =>
            writeAtomicFile(path, '{"a":1}\n', undefined, {
              randomUUID: () => 'fault',
              open: faultingOpen(temporaryPath, failurePhase, fault),
            }),
          fault,
        );
        assert.deepEqual(await readdir(dir), []);
      });
    });
  }

  test('removes its temp file and rethrows after a chmod failure', {
    skip: process.platform === 'win32',
  }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      const temporaryPath = `${path}.fault.tmp`;
      const fault = new Error('chmod failed');
      await assert.rejects(
        () =>
          writeAtomicFile(path, '{"a":1}\n', undefined, {
            randomUUID: () => 'fault',
            open: faultingOpen(temporaryPath, 'chmod', fault),
          }),
        fault,
      );
      assert.deepEqual(await readdir(dir), []);
    });
  });

  test('sets the final mode before synchronizing the temp file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      const phases: string[] = [];
      await writeAtomicFile(path, '{"a":1}\n', undefined, {
        open: async (temporaryPath, flags, mode) => {
          const handle = await open(temporaryPath, flags, mode);
          return {
            writeFile: async (data, encoding) => {
              phases.push('write');
              await handle.writeFile(data, encoding);
            },
            chmod: async (nextMode) => {
              phases.push('chmod');
              await handle.chmod(nextMode);
            },
            sync: async () => {
              phases.push('sync');
              await handle.sync();
            },
            close: async () => {
              phases.push('close');
              await handle.close();
            },
          };
        },
        syncDirectory: async () => {
          phases.push('sync-directory');
        },
      });
      assert.deepEqual(
        phases,
        isPosix
          ? ['write', 'chmod', 'sync', 'close', 'sync-directory']
          : ['write', 'sync', 'close', 'sync-directory'],
      );
    });
  });

  test('reports an unknown commit outcome when directory fsync fails after publication', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      const fault = new Error('dirsync failed');
      await assert.rejects(
        () =>
          writeAtomicFile(path, '{"a":1}\n', undefined, {
            syncDirectory: async () => {
              throw fault;
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof AtomicFileWriteCommitUnknownError);
          assert.equal(error.published, true);
          assert.equal(error.cause, fault);
          assert.match(error.message, /reload before retrying/);
          return true;
        },
      );
      // rename is the commit point: the replacement is live (readers get the
      // new bytes) even though its durability is not known to the caller.
      assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
      assert.deepEqual(await readdir(dir), ['settings.json']);
    });
  });

  test('creates the target 0600 on POSIX', { skip: process.platform === 'win32' }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      await writeAtomicFile(path, '{}\n');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
  });

  test('re-chmods a pre-existing world-readable target to 0600 on the next write', {
    skip: process.platform === 'win32',
  }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'settings.json');
      // A file created with a loose mode by an older writer.
      await writeFile(path, '{}\n', { encoding: 'utf8', mode: 0o644 });
      await writeAtomicFile(path, '{"a":1}\n');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
    });
  });

  test("dir 'harden' creates a 0700 directory chain for a nested target", {
    skip: process.platform === 'win32',
  }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'secrets', 'sub', 'credentials.json');
      await writeAtomicFile(path, '{}\n', { fileMode: 0o600, dir: 'harden' });
      assert.equal((await stat(join(dir, 'secrets'))).mode & 0o777, 0o700);
      assert.equal((await stat(join(dir, 'secrets', 'sub'))).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
  });

  test("dir 'harden' re-chmods a pre-existing world-accessible directory to 0700", {
    skip: process.platform === 'win32',
  }, async () => {
    await withTempDir(async (dir) => {
      const loose = join(dir, 'loose');
      await mkdir(loose, { recursive: true, mode: 0o777 });
      await chmod(loose, 0o777); // mkdir's mode only applies on creation
      await writeAtomicFile(join(loose, 'credentials.json'), '{}\n', { dir: 'harden' });
      // hardenDirectory re-chmods an existing dir; a failure would fail the
      // write rather than leave secrets in a world-readable directory.
      assert.equal((await stat(loose)).mode & 0o777, 0o700);
    });
  });

  test('refuses to write through a pre-planted symlink at the temp path', {
    skip: process.platform === 'win32',
  }, async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'credentials.json');
      const plantedTarget = join(dir, 'planted-target.json');
      await writeFile(plantedTarget, 'do not touch\n', 'utf8');
      // The injected randomUUID makes the unpredictable temp path knowable,
      // which is exactly the attacker model 'wx'/O_EXCL answers.
      await symlink(plantedTarget, `${path}.planted.tmp`);
      await assert.rejects(
        () => writeAtomicFile(path, '{}\n', undefined, { randomUUID: () => 'planted' }),
        { code: 'EEXIST' },
      );
      assert.equal(await readFile(plantedTarget, 'utf8'), 'do not touch\n');
      assert.equal(await stat(path).catch(() => null), null);
      // Cleanup removes only what the writer created: the planted entry is
      // still a symlink, exactly where it was.
      assert.equal((await lstat(`${path}.planted.tmp`)).isSymbolicLink(), true);
    });
  });
});

function faultingOpen(
  temporaryPath: string,
  failurePhase: 'write' | 'chmod' | 'sync' | 'close',
  fault: Error,
): AtomicFileWriteDependencies['open'] {
  return async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (path !== temporaryPath) return handle;

    let closeFailed = false;
    const wrapped: AtomicFileWriteHandle = {
      writeFile: async (data, encoding) => {
        if (failurePhase === 'write') {
          await handle.writeFile(data.slice(0, 1), encoding);
          throw fault;
        }
        await handle.writeFile(data, encoding);
      },
      chmod: async (mode) => {
        if (failurePhase === 'chmod') throw fault;
        await handle.chmod(mode);
      },
      sync: async () => {
        if (failurePhase === 'sync') throw fault;
        await handle.sync();
      },
      close: async () => {
        if (failurePhase === 'close' && !closeFailed) {
          closeFailed = true;
          await handle.close();
          throw fault;
        }
        await handle.close();
      },
    };
    return wrapped;
  };
}
