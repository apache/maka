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

/// <reference path="../../../storage/src/fs-native-extensions.d.ts" />
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tryLock } from 'fs-native-extensions';
import {
  resolveStorageRoot,
  resolveExistingStorageRoot,
  resolveRootHostDataDirectory,
  STORAGE_ROOT_MARKER_FILE,
} from '@maka/storage/root-authority';
import { prepareRuntimeHostRoot } from '../root-upgrade.js';
import { startExecutionRuntimeHostService } from '../server/execution-service.js';
import {
  createAccessCredentialFile,
  writeAccessCredentialFile,
  ACCESS_FILE_NAME,
} from '../server/access-credential-store.js';

for (const interruptedAt of ['takeover', 'copy', 'snapshot', 'ready']) {
  test(`upgrade automatically resumes after interruption at ${interruptedAt}`, async (t) => {
    const base = await mkdtemp(join(os.tmpdir(), 'maka-upgrade-'));
    const home = join(base, 'home');
    await mkdir(home);
    const info = os.userInfo();
    t.mock.method(os, 'userInfo', () => ({ ...info, homedir: home }));
    syncBuiltinESMExports();
    try {
      const root = join(base, 'state');
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE);
      const original = JSON.parse(await readFile(markerPath, 'utf8'));
      await writeFile(markerPath, JSON.stringify({ ...original, schemaVersion: 1 }));
      const cache =
        process.platform === 'darwin'
          ? join(home, 'Library', 'Caches', 'Maka')
          : process.platform === 'win32'
            ? join(home, 'AppData', 'Local', 'Maka')
            : join(home, '.cache', 'maka');
      const source = join(cache, 'runtime-hosts', capability.rootId);
      await mkdir(source, { recursive: true, mode: 0o700 });
      await writeAccessCredentialFile(
        join(source, ACCESS_FILE_NAME),
        createAccessCredentialFile([]),
      );
      await writeFile(join(source, 'plugin-state.json'), '{"value":"durable"}');
      const held = await open(join(source, 'owner.lock'), 'a+', 0o600);
      try {
        assert.ok(tryLock(held.fd));
        await assert.rejects(prepareRuntimeHostRoot(root, { migrationBusyWaitMs: 500 }), {
          code: 'root_migration_busy',
        });
        assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).schemaVersion, 1);
      } finally {
        await held.close();
      }
      const rename = fs.rename;
      const failCommit = t.mock.method(
        fs,
        'rename',
        async (...[from, to]: Parameters<typeof fs.rename>) => {
          if (to === markerPath) {
            const candidate = JSON.parse(await readFile(from, 'utf8'));
            if (
              (interruptedAt === 'ready' && !candidate.upgrade) ||
              (interruptedAt === 'takeover' && candidate.upgrade)
            )
              throw Object.assign(new Error('commit interrupted'), { code: 'EIO' });
          }
          if (
            interruptedAt === 'snapshot' &&
            to === join(capability.canonicalPath, '.maka-host', 'state')
          )
            throw Object.assign(new Error('snapshot interrupted'), { code: 'EIO' });
          return rename(from, to);
        },
      );
      const copy = fs.cp;
      const failCopy = t.mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
        if (interruptedAt === 'copy')
          throw Object.assign(new Error('copy interrupted'), { code: 'EIO' });
        return copy(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(prepareRuntimeHostRoot(root), { code: 'EIO' });
      await assert.rejects(
        resolveExistingStorageRoot({
          path: root,
          kind: 'interactive',
          expectedRootId: capability.rootId,
        }),
        { code: 'legacy_root_requires_migration' },
      );
      assert.equal(
        Boolean(JSON.parse(await readFile(markerPath, 'utf8')).upgrade),
        interruptedAt !== 'takeover',
      );
      failCommit.mock.restore();
      failCopy.mock.restore();
      if (interruptedAt === 'snapshot' || interruptedAt === 'ready')
        await rm(source, { recursive: true, force: true });
      if (interruptedAt !== 'takeover')
        t.mock.method(os, 'userInfo', () => {
          throw new Error('account unavailable after interruption');
        });
      syncBuiltinESMExports();
      if (interruptedAt === 'copy') {
        await rm(source, { recursive: true, force: true });
        await assert.rejects(prepareRuntimeHostRoot(root), { code: 'ENOENT' });
        assert.ok(JSON.parse(await readFile(markerPath, 'utf8')).upgrade);
        await mkdir(source, { recursive: true, mode: 0o700 });
        await writeAccessCredentialFile(
          join(source, ACCESS_FILE_NAME),
          createAccessCredentialFile([]),
        );
        await writeFile(join(source, 'plugin-state.json'), '{"value":"durable"}');
      }
      const recovered = await prepareRuntimeHostRoot(root);
      assert.equal(recovered.rootId, capability.rootId);
      assert.equal(
        await readFile(join(resolveRootHostDataDirectory(root), 'plugin-state.json'), 'utf8'),
        '{"value":"durable"}',
      );
      assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), original);
      await assert.rejects(
        fs.stat(join(capability.canonicalPath, '.maka-host', 'upgrade-plan.json')),
        { code: 'ENOENT' },
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('a torn upgrade completion record restages instead of wedging the root', async (t) => {
  const base = await mkdtemp(join(os.tmpdir(), 'maka-upgrade-torn-'));
  const home = join(base, 'home');
  await mkdir(home);
  const info = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...info, homedir: home }));
  syncBuiltinESMExports();
  try {
    const root = join(base, 'state');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const markerPath = join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE);
    const original = JSON.parse(await readFile(markerPath, 'utf8'));
    await writeFile(markerPath, JSON.stringify({ ...original, schemaVersion: 1 }));
    const cache =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Caches', 'Maka')
        : process.platform === 'win32'
          ? join(home, 'AppData', 'Local', 'Maka')
          : join(home, '.cache', 'maka');
    const source = join(cache, 'runtime-hosts', capability.rootId);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeAccessCredentialFile(join(source, ACCESS_FILE_NAME), createAccessCredentialFile([]));
    const rename = fs.rename;
    let failed = false;
    const failRename = t.mock.method(
      fs,
      'rename',
      async (...[from, to]: Parameters<typeof fs.rename>) => {
        if (!failed && to === join(capability.canonicalPath, '.maka-host', 'state')) {
          failed = true;
          throw Object.assign(new Error('snapshot interrupted'), { code: 'EIO' });
        }
        return rename(from, to);
      },
    );
    syncBuiltinESMExports();
    await assert.rejects(prepareRuntimeHostRoot(root), { code: 'EIO' });
    const authority = join(capability.canonicalPath, '.maka-host');
    // The fence carries only the transaction id; the plan lives in its own file.
    const fenced = JSON.parse(await readFile(markerPath, 'utf8'));
    assert.deepEqual(Object.keys(fenced.upgrade), ['id']);
    const plan = JSON.parse(await readFile(join(authority, 'upgrade-plan.json'), 'utf8'));
    assert.equal(plan.data, source);
    const staged = (await fs.readdir(authority)).find((entry) => entry.startsWith('upgrade-'));
    assert.ok(staged);
    failRename.mock.restore();
    // Corrupt the durable completion record: the staged copy can no longer
    // prove itself, so the retry must restage from the source.
    await writeFile(join(authority, staged, '.upgrade-complete.json'), '{"migrationId"');
    const recovered = await prepareRuntimeHostRoot(root);
    assert.equal(recovered.rootId, capability.rootId);
    assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), original);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a legacy source disappearing during lock admission fails the upgrade', async (t) => {
  const base = await mkdtemp(join(os.tmpdir(), 'maka-upgrade-vanish-'));
  const home = join(base, 'home');
  await mkdir(home);
  const info = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...info, homedir: home }));
  syncBuiltinESMExports();
  try {
    const root = join(base, 'state');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const markerPath = join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE);
    const original = JSON.parse(await readFile(markerPath, 'utf8'));
    await writeFile(markerPath, JSON.stringify({ ...original, schemaVersion: 1 }));
    const cache =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Caches', 'Maka')
        : process.platform === 'win32'
          ? join(home, 'AppData', 'Local', 'Maka')
          : join(home, '.cache', 'maka');
    const source = join(cache, 'runtime-hosts', capability.rootId);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeAccessCredentialFile(join(source, ACCESS_FILE_NAME), createAccessCredentialFile([]));
    // The sources are re-inspected after legacy lock admission; a source that
    // vanishes in between must fail the upgrade rather than be committed as
    // an empty directory. Admission creates the state-root-owners directory
    // between the two inspections, which is the injection point.
    const mkdirOriginal = fs.mkdir;
    t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]).endsWith('state-root-owners'))
        await rm(source, { recursive: true, force: true });
      return mkdirOriginal(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(prepareRuntimeHostRoot(root), /Legacy sources changed/);
    assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).schemaVersion, 1);
    await assert.rejects(
      fs.stat(join(capability.canonicalPath, '.maka-host', 'upgrade-plan.json')),
      { code: 'ENOENT' },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('the service entry upgrades a legacy root before serving', async (t) => {
  const base = await mkdtemp(join(os.tmpdir(), 'maka-upgrade-serve-'));
  const home = join(base, 'home');
  await mkdir(home);
  const info = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...info, homedir: home }));
  syncBuiltinESMExports();
  const root = join(base, 'state');
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const markerPath = join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    await writeFile(markerPath, JSON.stringify({ ...marker, schemaVersion: 1 }));
    const host = await startExecutionRuntimeHostService({ rootPath: root });
    try {
      assert.equal(host.rootId, capability.rootId);
      assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).schemaVersion, 2);
    } finally {
      await host.close();
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('an uninitialized legacy root upgrades with an inaccessible absent account home', async (t) => {
  const base = await mkdtemp(join(os.tmpdir(), 'maka-upgrade-no-home-'));
  const root = join(base, 'state');
  const missingHome = join(base, 'not-created');
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const path = join(root, STORAGE_ROOT_MARKER_FILE);
    const marker = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...marker, schemaVersion: 1 }));
    const info = os.userInfo();
    t.mock.method(os, 'userInfo', () => ({ ...info, homedir: missingHome }));
    const mkdir = fs.mkdir;
    t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]).startsWith(missingHome))
        throw Object.assign(new Error('account home is not writable'), { code: 'EACCES' });
      return mkdir(...args);
    });
    syncBuiltinESMExports();
    await writeFile(join(root, 'business-state.json'), '{"retained":true}');
    const upgraded = await prepareRuntimeHostRoot(root);
    assert.equal(await readFile(join(root, 'business-state.json'), 'utf8'), '{"retained":true}');
    assert.equal(upgraded.rootId, capability.rootId);
    await assert.rejects(fs.stat(missingHome), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(resolveRootHostDataDirectory(root)), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

async function fencedUpgradeFixture(
  t: import('node:test').TestContext,
  prefix: string,
): Promise<{ base: string; root: string; capability: { rootId: string; canonicalPath: string } }> {
  const base = await mkdtemp(join(os.tmpdir(), prefix));
  const home = join(base, 'home');
  await mkdir(home);
  const info = os.userInfo();
  t.mock.method(os, 'userInfo', () => ({ ...info, homedir: home }));
  const root = join(base, 'state');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const markerPath = join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  await writeFile(markerPath, JSON.stringify({ ...marker, schemaVersion: 1 }));
  const cache =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'Maka')
      : process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'Maka')
        : join(home, '.cache', 'maka');
  const source = join(cache, 'runtime-hosts', capability.rootId);
  await mkdir(source, { recursive: true, mode: 0o700 });
  await writeAccessCredentialFile(join(source, ACCESS_FILE_NAME), createAccessCredentialFile([]));
  await writeFile(join(source, 'plugin-state.json'), '{"value":"durable"}');
  const failCopy = t.mock.method(fs, 'cp', async () => {
    throw Object.assign(new Error('copy interrupted'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  await assert.rejects(prepareRuntimeHostRoot(root), { code: 'EIO' });
  failCopy.mock.restore();
  syncBuiltinESMExports();
  return { base, root, capability };
}

test('a fenced upgrade fails closed when its plan file is missing', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-no-plan-');
  try {
    const authority = join(capability.canonicalPath, '.maka-host');
    await rm(join(authority, 'upgrade-plan.json'));
    // The durable fence makes the plan a required transaction input; losing it
    // must not silently re-derive a plan and drop the recorded successor.
    await assert.rejects(prepareRuntimeHostRoot(root), /missing or corrupt/u);
    assert.ok(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .upgrade,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a fenced upgrade rejects a plan bound to another root', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-foreign-plan-');
  try {
    const planPath = join(capability.canonicalPath, '.maka-host', 'upgrade-plan.json');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    await writeFile(planPath, JSON.stringify({ ...plan, rootId: '0'.repeat(64) }));
    await assert.rejects(prepareRuntimeHostRoot(root), /missing or corrupt/u);
    assert.ok(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .upgrade,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('upgrade resume recreates legacy lock directories removed while fenced', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-lockdirs-');
  try {
    const home = join(base, 'home');
    const cache =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Caches', 'Maka')
        : process.platform === 'win32'
          ? join(home, 'AppData', 'Local', 'Maka')
          : join(home, '.cache', 'maka');
    const durable =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Maka')
        : process.platform === 'win32'
          ? join(home, 'AppData', 'Local', 'Maka')
          : join(home, '.local', 'share', 'Maka');
    await rm(join(durable, 'state-root-owners'), { recursive: true, force: true });
    await rm(join(cache, 'runtime-hosts', 'artifact-writer-bootstrap'), {
      recursive: true,
      force: true,
    });
    const upgraded = await prepareRuntimeHostRoot(root);
    assert.equal(upgraded.rootId, capability.rootId);
    // The locks are durable artifacts of admission: absence must recreate them.
    assert.deepEqual(await fs.readdir(join(durable, 'state-root-owners')), [
      `${capability.rootId}.lock`,
    ]);
    assert.match(
      (await fs.readdir(join(cache, 'runtime-hosts', 'artifact-writer-bootstrap')))[0] ?? '',
      /^[0-9a-f]{64}\.lock$/u,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a committed snapshot that fails validation is restaged once', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-restaged-');
  try {
    const committed = join(capability.canonicalPath, '.maka-host', 'state');
    const rename = fs.rename;
    let corrupted = false;
    t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
      await rename(from, to);
      if (to === committed && !corrupted) {
        corrupted = true;
        await writeFile(join(to, 'data', ACCESS_FILE_NAME), '{"credential"');
      }
    });
    syncBuiltinESMExports();
    const upgraded = await prepareRuntimeHostRoot(root);
    assert.equal(upgraded.rootId, capability.rootId);
    assert.equal(
      await readFile(join(resolveRootHostDataDirectory(root), 'plugin-state.json'), 'utf8'),
      '{"value":"durable"}',
    );
    assert.equal(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .schemaVersion,
      2,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a fenced upgrade treats state without its completion record as debris', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-debris-');
  try {
    const committed = join(capability.canonicalPath, '.maka-host', 'state');
    await mkdir(join(committed, 'data'), { recursive: true });
    await writeFile(join(committed, 'data', 'foreign.json'), '{}');
    const upgraded = await prepareRuntimeHostRoot(root);
    assert.equal(upgraded.rootId, capability.rootId);
    assert.equal(
      await readFile(join(resolveRootHostDataDirectory(root), 'plugin-state.json'), 'utf8'),
      '{"value":"durable"}',
    );
    await assert.rejects(readFile(join(committed, 'data', 'foreign.json')));
    assert.equal(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .schemaVersion,
      2,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a committed snapshot missing a staged directory is restaged', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-hollow-');
  try {
    const marker = JSON.parse(
      await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'),
    );
    const committed = join(capability.canonicalPath, '.maka-host', 'state');
    // A snapshot reduced to its completion record still proves completion but
    // not survival; without the data directory assertion this commits empty.
    await mkdir(join(committed, 'deployment'), { recursive: true });
    await writeFile(
      join(committed, '.upgrade-complete.json'),
      JSON.stringify({ migrationId: marker.upgrade.id }),
    );
    const upgraded = await prepareRuntimeHostRoot(root);
    assert.equal(upgraded.rootId, capability.rootId);
    assert.equal(
      await readFile(join(resolveRootHostDataDirectory(root), 'plugin-state.json'), 'utf8'),
      '{"value":"durable"}',
    );
    assert.equal(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .schemaVersion,
      2,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a fenced upgrade reuses complete staging over committed debris', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-reuse-');
  try {
    const marker = JSON.parse(
      await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'),
    );
    const authority = join(capability.canonicalPath, '.maka-host');
    const staging = join(authority, `upgrade-${marker.upgrade.id}`);
    const cache =
      process.platform === 'darwin'
        ? join(base, 'home', 'Library', 'Caches', 'Maka')
        : process.platform === 'win32'
          ? join(base, 'home', 'AppData', 'Local', 'Maka')
          : join(base, 'home', '.cache', 'maka');
    await fs.cp(join(cache, 'runtime-hosts', capability.rootId), join(staging, 'data'), {
      recursive: true,
    });
    await mkdir(join(staging, 'deployment'), { recursive: true });
    // A canary that only a completed staging carries proves resume renames the
    // existing snapshot instead of restaging it.
    await writeFile(join(staging, 'data', 'canary.txt'), 'staged');
    await writeFile(
      join(staging, '.upgrade-complete.json'),
      JSON.stringify({ migrationId: marker.upgrade.id, deploymentRecord: false }),
    );
    await mkdir(join(authority, 'state', 'data'), { recursive: true });
    await writeFile(join(authority, 'state', 'data', 'foreign.json'), '{}');
    const upgraded = await prepareRuntimeHostRoot(root);
    assert.equal(upgraded.rootId, capability.rootId);
    const committed = resolveRootHostDataDirectory(root);
    assert.equal(await readFile(join(committed, 'canary.txt'), 'utf8'), 'staged');
    assert.equal(
      await readFile(join(committed, 'plugin-state.json'), 'utf8'),
      '{"value":"durable"}',
    );
    await assert.rejects(readFile(join(committed, 'foreign.json')));
    assert.equal(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .schemaVersion,
      2,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});

test('a committed snapshot that keeps failing validation fails closed', async (t) => {
  const { base, root, capability } = await fencedUpgradeFixture(t, 'maka-upgrade-wedged-');
  try {
    const committed = join(capability.canonicalPath, '.maka-host', 'state');
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
      await rename(from, to);
      if (to === committed) await writeFile(join(to, 'data', ACCESS_FILE_NAME), '{"credential"');
    });
    syncBuiltinESMExports();
    // The first committed snapshot restages; when the restaged copy fails the
    // same check the upgrade stops instead of looping forever.
    await assert.rejects(prepareRuntimeHostRoot(root));
    assert.ok(
      JSON.parse(await readFile(join(capability.canonicalPath, STORAGE_ROOT_MARKER_FILE), 'utf8'))
        .upgrade,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});
