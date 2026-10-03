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
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  createSqliteArtifactStoreWriteAuthority,
  type ArtifactAuthorityStore,
} from '../artifact-store.js';

async function withStore(run: (store: ArtifactAuthorityStore, root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maka-artifact-batch-')));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    await run(authority.store, root);
  } finally {
    authority.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function create(store: ArtifactAuthorityStore, sessionId: string, id: string, name = `${id}.txt`) {
  return store.create({
    id,
    sessionId,
    turnId: 'turn-1',
    name,
    kind: 'file',
    source: 'tool_result',
    content: `payload ${id}`,
    now: 1,
  });
}

function fulfilled(results: ReadonlyMap<string, PromiseSettledResult<void>>, sessionId: string) {
  assert.deepEqual(results.get(sessionId), { status: 'fulfilled', value: undefined });
}

function rejected(results: ReadonlyMap<string, PromiseSettledResult<void>>, sessionId: string) {
  const result = results.get(sessionId);
  assert.equal(result?.status, 'rejected');
  if (result?.status !== 'rejected') throw new Error('Expected rejection');
  return result.reason as Error;
}

test('batch purge reads metadata and resolves retained payloads once, committing only target ids', async (t) => {
  await withStore(async (store, root) => {
    const retained = await Promise.all(
      Array.from({ length: 16 }, (_, i) => create(store, 'keep', `keep-${i}`)),
    );
    const targets = await Promise.all(
      Array.from({ length: 8 }, (_, i) => create(store, `retire-${i}`, `target-${i}`)),
    );
    const retainedPaths = new Set(retained.map((r) => join(root, 'artifacts', r.relativePath)));
    const scans = new Map<string, number>();
    let reads = 0;
    let writes = 0;
    const originalLstat = fs.lstat;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const lstat = t.mock.method(fs, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
      const path = String(args[0]);
      if (retainedPaths.has(path)) scans.set(path, (scans.get(path) ?? 0) + 1);
      return originalLstat(...args);
    });
    const prepare = t.mock.method(
      DatabaseSync.prototype,
      'prepare',
      function (this: DatabaseSync, sql: string) {
        if (/SELECT record_json\s+FROM artifact_records/.test(sql)) reads++;
        if (sql === 'DELETE FROM artifact_records WHERE artifact_id = ?') writes++;
        return originalPrepare.call(this, sql);
      },
    );
    syncBuiltinESMExports();
    try {
      const ids = targets.map((r) => r.sessionId);
      const results = await store.purgeSessionArtifactsBatch([...ids, ids[0]!, 'empty']);
      assert.equal(results.size, ids.length + 1);
      for (const id of [...ids, 'empty']) fulfilled(results, id);
      assert.equal(scans.size, retainedPaths.size);
      assert.ok([...scans.values()].every((n) => n === 1));
      assert.equal(reads, 1);
      assert.equal(writes, 1);
      const replay = await store.purgeSessionArtifactsBatch(ids);
      for (const id of ids) fulfilled(replay, id);
      assert.ok([...scans.values()].every((n) => n === 1));
      assert.equal(writes, 1);
      assert.equal(reads, 2);
      await store.purgeSessionArtifactsBatch([]);
      assert.equal(reads, 2);
    } finally {
      lstat.mock.restore();
      prepare.mock.restore();
      syncBuiltinESMExports();
    }
    for (const record of retained)
      assert.equal(
        await fs.readFile(join(root, 'artifacts', record.relativePath), 'utf8'),
        `payload ${record.id}`,
      );
    for (const record of targets)
      await assert.rejects(fs.stat(join(root, 'artifacts', record.relativePath)), {
        code: 'ENOENT',
      });
    assert.equal((await store.listPage('keep', { offset: 0, limit: 100 })).total, 16);
  });
});

test('a target unlink failure retains only that Session and retries after reopen', async (t) => {
  await withStore(async (store, root) => {
    const first = await create(store, 'fail', 'first');
    const blocked = await create(store, 'fail', 'second');
    const good = await create(store, 'good', 'good');
    const target = join(root, 'artifacts', blocked.relativePath);
    const originalRm = fs.rm;
    const mock = t.mock.method(fs, 'rm', async (...args: Parameters<typeof originalRm>) => {
      if (args[0] === target)
        throw Object.assign(new Error('injected unlink failure'), { code: 'EIO' });
      return originalRm(...args);
    });
    syncBuiltinESMExports();
    try {
      const results = await store.purgeSessionArtifactsBatch(['fail', 'good']);
      assert.match(rejected(results, 'fail').message, /injected unlink failure/);
      fulfilled(results, 'good');
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal((await store.listPage('fail', { offset: 0, limit: 10 })).total, 2);
    assert.equal((await store.listPage('good', { offset: 0, limit: 10 })).total, 0);
    await assert.rejects(fs.stat(join(root, 'artifacts', first.relativePath)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(join(root, 'artifacts', good.relativePath)), { code: 'ENOENT' });
    store.close();
    const reopened = createSqliteArtifactStoreWriteAuthority(root);
    try {
      const results = await reopened.store.purgeSessionArtifactsBatch(['fail', 'good']);
      fulfilled(results, 'fail');
      fulfilled(results, 'good');
      assert.equal((await reopened.store.listPage('fail', { offset: 0, limit: 10 })).total, 0);
    } finally {
      reopened.close();
    }
  });
});

test('directory sync failure keeps its Session retryable without blocking a successful sibling', async (t) => {
  if (process.platform === 'win32') return t.skip('directory fsync is a POSIX durability barrier');
  await withStore(async (store, root) => {
    const failed = await create(store, 'fail', 'fail');
    await create(store, 'good', 'good');
    const targetDirectory = dirname(join(root, 'artifacts', failed.relativePath));
    const originalOpen = fs.open;
    const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof originalOpen>) => {
      if (args[0] === targetDirectory)
        throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 2; i++) {
        const results = await store.purgeSessionArtifactsBatch(['fail', 'good']);
        assert.match(rejected(results, 'fail').message, /injected directory sync failure/);
        fulfilled(results, 'good');
        assert.equal((await store.listPage('fail', { offset: 0, limit: 10 })).total, 1);
      }
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    store.close();
    const reopened = createSqliteArtifactStoreWriteAuthority(root);
    try {
      fulfilled(await reopened.store.purgeSessionArtifactsBatch(['fail']), 'fail');
      assert.equal((await reopened.store.listPage('fail', { offset: 0, limit: 10 })).total, 0);
    } finally {
      reopened.close();
    }
  });
});

test('a failed metadata transaction rolls back the complete batch and can recover missing payloads', async () => {
  await withStore(async (store, root) => {
    const a = await create(store, 'a', 'a');
    const b = await create(store, 'b', 'b');
    const database = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      database.exec(`CREATE TRIGGER fail_batch_delete BEFORE DELETE ON artifact_records
        WHEN OLD.artifact_id = 'b' BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`);
      await assert.rejects(
        store.purgeSessionArtifactsBatch(['a', 'b']),
        /injected metadata failure/,
      );
      for (const r of [a, b]) {
        assert.equal((await store.listPage(r.sessionId, { offset: 0, limit: 10 })).total, 1);
        await assert.rejects(fs.stat(join(root, 'artifacts', r.relativePath)), { code: 'ENOENT' });
      }
      database.exec('DROP TRIGGER fail_batch_delete');
    } finally {
      database.close();
    }
    store.close();
    const reopened = createSqliteArtifactStoreWriteAuthority(root);
    try {
      const results = await reopened.store.purgeSessionArtifactsBatch(['a', 'b']);
      fulfilled(results, 'a');
      fulfilled(results, 'b');
      for (const id of ['a', 'b'])
        assert.equal((await reopened.store.listPage(id, { offset: 0, limit: 10 })).total, 0);
    } finally {
      reopened.close();
    }
  });
});

test('batch admission snapshots caller ids and rejects invalid ids before deleting anything', async () => {
  await withStore(async (store, root) => {
    const a = await create(store, 'a', 'a');
    const b = await create(store, 'b', 'b');
    await assert.rejects(store.purgeSessionArtifactsBatch(['a', '../bad']));
    assert.equal(await fs.readFile(join(root, 'artifacts', a.relativePath), 'utf8'), 'payload a');
    const ids = ['a'];
    const operation = store.purgeSessionArtifactsBatch(ids);
    ids[0] = 'b';
    fulfilled(await operation, 'a');
    assert.equal(await fs.readFile(join(root, 'artifacts', b.relativePath), 'utf8'), 'payload b');
  });
});

async function symlinkOrSkip(t: TestContext, target: string, path: string) {
  try {
    await fs.symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows symlinks require Developer Mode or elevation');
      return false;
    }
    throw error;
  }
}

test('batch preserves cross-Session alias guards even when both aliases are targets', async (t) => {
  await withStore(async (store, root) => {
    const a = await create(store, 'a', 'shared', 'b-file.txt');
    const b = await create(store, 'b', 'shared-b', 'file.txt');
    await create(store, 'good', 'good');
    const aPath = join(root, 'artifacts', a.relativePath);
    const bPath = join(root, 'artifacts', b.relativePath);
    // Both canonical records have the same basename; aliasing the parent
    // directories must not let either Session delete the other's payload.
    await fs.rm(bPath);
    await fs.rmdir(dirname(bPath));
    if (!(await symlinkOrSkip(t, dirname(aPath), dirname(bPath)))) return;
    const results = await store.purgeSessionArtifactsBatch(['a', 'b', 'good']);
    assert.match(rejected(results, 'a').message, /path is still referenced/);
    assert.match(rejected(results, 'b').message, /path is still referenced/);
    fulfilled(results, 'good');
    assert.equal(await fs.readFile(aPath, 'utf8'), `payload ${a.id}`);
    for (const id of ['a', 'b'])
      assert.equal((await store.listPage(id, { offset: 0, limit: 10 })).total, 1);
  });
});

test('batch joins all path resolutions before rejecting an unresolved guard and releases its writer queue', async (t) => {
  await withStore(async (store, root) => {
    const kept = await create(store, 'keep', 'keep');
    const target = await create(store, 'target', 'target');
    const keptPath = join(root, 'artifacts', kept.relativePath);
    const originalLstat = fs.lstat;
    let active = 0;
    const mock = t.mock.method(fs, 'lstat', async (...args: Parameters<typeof originalLstat>) => {
      active++;
      try {
        if (args[0] === keptPath)
          throw Object.assign(new Error('injected guard resolution failure'), { code: 'EIO' });
        return await originalLstat(...args);
      } finally {
        active--;
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        store.purgeSessionArtifactsBatch(['target']),
        /injected guard resolution failure/,
      );
      assert.equal(active, 0);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(
      await fs.readFile(join(root, 'artifacts', target.relativePath), 'utf8'),
      'payload target',
    );
    fulfilled(await store.purgeSessionArtifactsBatch(['target']), 'target');
  });
});

for (const phase of ['after-unlink', 'after-metadata']) {
  test(`batch purge recovers after a process is killed ${phase}`, { timeout: 15_000 }, async () => {
    await withStore(async (store, root) => {
      const first = await create(store, 'a', 'first');
      const second = await create(store, 'a', 'second');
      const sibling = await create(store, 'b', 'sibling');
      const kept = await create(store, 'keep', 'kept');
      store.close();
      const child = fork(
        new URL('./fixtures/artifact-batch-purge-crash.js', import.meta.url),
        [root, phase, join(root, 'artifacts', first.relativePath)],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      const exit = once(child, 'exit');
      try {
        const message = await Promise.race([
          once(child, 'message').then(([value]) => value),
          exit.then(([code, signal]) => {
            throw new Error(`Child exited before crash point (${code}, ${signal}): ${stderr}`);
          }),
        ]);
        assert.equal(message, phase);
        child.kill('SIGKILL');
        const [code, signal] = await exit;
        assert.ok(signal === 'SIGKILL' || (process.platform === 'win32' && code !== 0));
        const reopened = createSqliteArtifactStoreWriteAuthority(root);
        try {
          assert.equal(
            (await reopened.store.listPage('a', { offset: 0, limit: 10 })).total,
            phase === 'after-unlink' ? 2 : 0,
          );
          await assert.rejects(fs.stat(join(root, 'artifacts', first.relativePath)), {
            code: 'ENOENT',
          });
          const result = await reopened.store.purgeSessionArtifactsBatch(['a', 'b']);
          fulfilled(result, 'a');
          fulfilled(result, 'b');
          for (const r of [first, second, sibling])
            await assert.rejects(fs.stat(join(root, 'artifacts', r.relativePath)), {
              code: 'ENOENT',
            });
          for (const id of ['a', 'b'])
            assert.equal((await reopened.store.listPage(id, { offset: 0, limit: 10 })).total, 0);
          assert.equal(
            await fs.readFile(join(root, 'artifacts', kept.relativePath), 'utf8'),
            'payload kept',
          );
        } finally {
          reopened.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exit;
      }
    });
  });
}
