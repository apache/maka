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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRuntimeHostSetupPackageResolver } from '../runtime-host-setup-package.js';

const ARCHIVE_BYTES = Buffer.from('development archive');
const ARCHIVE_INTEGRITY = `sha512-${createHash('sha512').update(ARCHIVE_BYTES).digest('base64')}`;

test('development setup lazily caches CLI archives by peer target unless overridden', async (t) => {
  const repoRoot = resolve('/workspace');
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'maka-agent-dev.tgz');
  await writeFile(archive, ARCHIVE_BYTES);
  const canonicalArchive = await realpath(archive);
  let builds = 0;
  let closes = 0;
  const targets: string[] = [];
  const resolvePackage = createRuntimeHostSetupPackageResolver({
    isPackaged: false,
    appPath: join(repoRoot, 'apps', 'desktop'),
    environment: {},
    startDevelopmentArchiveBuild: (resolvedRoot, target) => {
      builds += 1;
      targets.push(target);
      assert.equal(resolvedRoot, repoRoot);
      return {
        result: Promise.resolve(archive),
        close: async () => {
          closes += 1;
        },
      };
    },
  });

  assert.equal(resolvePackage.mode, 'development');
  assert.deepEqual(await Promise.all([
    resolvePackage.resolve('linux-x64'),
    resolvePackage.resolve('linux-x64'),
  ]), [
    {
      kind: 'development_archive',
      path: canonicalArchive,
      integrity: ARCHIVE_INTEGRITY,
    },
    {
      kind: 'development_archive',
      path: canonicalArchive,
      integrity: ARCHIVE_INTEGRITY,
    },
  ]);
  await resolvePackage.resolve('none');
  assert.equal(builds, 2);
  assert.deepEqual(targets, ['linux-x64', 'none']);

  const override = join(directory, 'explicit.tgz');
  await writeFile(override, ARCHIVE_BYTES);
  const resolveOverride = createRuntimeHostSetupPackageResolver({
    isPackaged: false,
    appPath: join(repoRoot, 'apps', 'desktop'),
    environment: { MAKA_RUNTIME_HOST_SETUP_ARCHIVE: override },
    startDevelopmentArchiveBuild: () => assert.fail('override must bypass the local build'),
  });
  const snapshot = await resolveOverride.resolve('none');
  assert.equal(snapshot.kind, 'development_archive');
  assert.notEqual(snapshot.path, await realpath(override));
  assert.equal(snapshot.integrity, ARCHIVE_INTEGRITY);
  await writeFile(override, 'replacement archive');
  assert.deepEqual(await readFile(snapshot.path), ARCHIVE_BYTES);
  assert.deepEqual(await resolveOverride.resolve('none'), snapshot);

  await resolveOverride.close();
  await assert.rejects(readFile(snapshot.path), { code: 'ENOENT' });

  const invalidOverride = join(directory, 'explicit.zip');
  await writeFile(invalidOverride, ARCHIVE_BYTES);
  const resolveInvalidOverride = createRuntimeHostSetupPackageResolver({
    isPackaged: false,
    appPath: join(repoRoot, 'apps', 'desktop'),
    environment: { MAKA_RUNTIME_HOST_SETUP_ARCHIVE: invalidOverride },
  });
  await assert.rejects(resolveInvalidOverride.resolve('none'), /must be a \.tgz file/u);
  await Promise.all([
    resolvePackage.close(),
    resolveInvalidOverride.close(),
  ]);
  assert.equal(closes, 2);
});

test('a packaged desktop resolves its own setup package without a development peer target', async (t) => {
  const appPath = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-packaged-'));
  t.after(() => rm(appPath, { recursive: true, force: true }));
  await writeFile(
    join(appPath, 'package.json'),
    JSON.stringify({ runtimeHostSetupPackage: 'maka-agent@1.2.3' }),
  );
  // Packaged builds ship on tuples that have no npm prebuild — macOS x64 — so
  // reading the development peer target here would fail the local Runtime Host.
  const resolver = createRuntimeHostSetupPackageResolver({
    isPackaged: true,
    appPath,
    environment: {},
    startDevelopmentArchiveBuild: () => assert.fail('a packaged desktop must not build the CLI'),
  });
  t.after(() => resolver.close());

  assert.equal(resolver.mode, 'published');
  assert.deepEqual(await resolver.resolveForThisDesktop(), {
    kind: 'npm',
    specifier: 'maka-agent@1.2.3',
  });
});

test('cancelling the last waiter closes its build before a new setup starts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const freshArchive = join(directory, 'fresh.tgz');
  await writeFile(freshArchive, ARCHIVE_BYTES);
  const canonicalFreshArchive = await realpath(freshArchive);
  const cancelled = new AbortController();
  let builds = 0;
  let rejectBuild!: (error: Error) => void;
  let releaseClose!: () => void;
  let signalClose!: () => void;
  let closes = 0;
  const closeStarted = new Promise<void>((resolveClose) => {
    signalClose = resolveClose;
  });
  const closeBarrier = new Promise<void>((resolveClose) => {
    releaseClose = resolveClose;
  });
  const resolver = createRuntimeHostSetupPackageResolver({
    isPackaged: false,
    appPath: '/workspace/apps/desktop',
    environment: {},
    startDevelopmentArchiveBuild: () => {
      builds += 1;
      if (builds > 1) {
        return {
          result: Promise.resolve(freshArchive),
          close: async () => undefined,
        };
      }
      return {
        result: new Promise((_resolve, reject) => {
          rejectBuild = reject;
        }),
        close: async () => {
          closes += 1;
          signalClose();
          await closeBarrier;
          rejectBuild(new Error('build stopped'));
        },
      };
    },
  });

  const first = resolver.resolve('linux-x64', cancelled.signal);
  cancelled.abort(new Error('setup cancelled'));
  await closeStarted;
  const second = resolver.resolve('linux-x64');
  await Promise.resolve();
  assert.equal(builds, 1);

  releaseClose();
  await assert.rejects(first, /setup cancelled/u);
  assert.deepEqual(await second, {
    kind: 'development_archive',
    path: canonicalFreshArchive,
    integrity: ARCHIVE_INTEGRITY,
  });
  assert.equal(builds, 2);
  assert.equal(closes, 1);
  await resolver.close();
});
