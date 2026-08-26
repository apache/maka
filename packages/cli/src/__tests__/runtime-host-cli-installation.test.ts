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
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  isTemporaryNpxInstallation,
  resolveRuntimeHostNpmGlobalInstallation,
  RuntimeHostCliInstallationError,
} from '../runtime-host-cli-installation.js';

test('keeps one owner across release changes in the same npm global slot', async (t) => {
  const fixture = await installationFixture(t, '1.0.0');
  const first = await resolve(fixture);
  await writeFile(fixture.manifestUrl, JSON.stringify({ name: 'maka-agent', version: '2.0.0' }));
  const upgraded = await resolve(fixture);

  assert.equal(first.owner.installationId, upgraded.owner.installationId);
  assert.deepEqual(first.observedRelease, {
    version: '1.0.0',
    packageRoot: fixture.packageRoot,
    cliPath: fixture.cliPath,
  });
  assert.deepEqual(upgraded.observedRelease, {
    ...first.observedRelease,
    version: '2.0.0',
  });
  assert.equal('deployment' in upgraded, false);
});

test('uses distinct owners for distinct active npm global roots', async (t) => {
  const firstFixture = await installationFixture(t, '1.0.0');
  const secondFixture = await installationFixture(t, '1.0.0');
  const [first, second] = await Promise.all([resolve(firstFixture), resolve(secondFixture)]);

  assert.notEqual(first.owner.installationId, second.owner.installationId);
});

test('rejects a package outside the active npm global root', async (t) => {
  const fixture = await installationFixture(t, '1.0.0');
  const differentRoot = join(fixture.base, 'other', 'node_modules');
  await mkdir(differentRoot, { recursive: true });

  await assert.rejects(
    resolveRuntimeHostNpmGlobalInstallation(
      { manifestUrl: fixture.manifestUrl, homeDir: fixture.homeDir },
      { resolveGlobalNodeModulesRoot: async () => differentRoot },
    ),
    installationError('unsupported_installation'),
  );
});

test('rejects development and npx packages before treating them as owners', async (t) => {
  const development = await installationFixture(t, '1.0.0');
  await writeFile(
    development.manifestUrl,
    JSON.stringify({ name: 'maka-agent', version: '1.0.0', private: true }),
  );
  await assert.rejects(resolve(development), installationError('unsupported_installation'));

  const cacheRoot = await mkdtemp(join(tmpdir(), 'maka-cli-npx-installation-'));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const packageRoot = join(cacheRoot, '_npx', 'hash', 'node_modules', 'maka-agent');
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  const manifestUrl = pathToFileURL(join(packageRoot, 'package.json'));
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(cliPath, '#!/usr/bin/env node\n');
  await writeFile(manifestUrl, JSON.stringify({ name: 'maka-agent', version: '1.0.0' }));
  let npmRootRequested = false;

  await assert.rejects(
    resolveRuntimeHostNpmGlobalInstallation(
      {
        manifestUrl,
        environment: { npm_config_cache: cacheRoot },
        homeDir: join(cacheRoot, 'home'),
      },
      {
        resolveGlobalNodeModulesRoot: async () => {
          npmRootRequested = true;
          return dirname(packageRoot);
        },
      },
    ),
    installationError('unsupported_installation'),
  );
  assert.equal(npmRootRequested, false);
});

test('recognizes configured and default npx cache roots without prefix collisions', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-cli-npx-provenance-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const configured = join(base, 'cache', '_npx', 'one', 'node_modules', 'maka-agent');
  const defaultCache = join(base, 'home', '.npm', '_npx', 'two', 'node_modules', 'maka-agent');
  const collision = join(base, 'cache', '_npx-other', 'maka-agent');
  await Promise.all([
    mkdir(configured, { recursive: true }),
    mkdir(defaultCache, { recursive: true }),
    mkdir(collision, { recursive: true }),
  ]);
  const input = {
    environment: { npm_config_cache: join(base, 'cache') },
    homeDir: join(base, 'home'),
  };

  assert.equal(await isTemporaryNpxInstallation(configured, input), true);
  assert.equal(await isTemporaryNpxInstallation(defaultCache, input), true);
  assert.equal(await isTemporaryNpxInstallation(collision, input), false);
});

test('rejects non-UTF-8 package metadata instead of normalizing an owner observation', async (t) => {
  const fixture = await installationFixture(t, '1.0.0');
  const document = Buffer.from(JSON.stringify({ name: 'maka-agent', version: '1.0.0' }));
  document[document.indexOf('1.0.0')] = 0xff;
  await writeFile(fixture.manifestUrl, document);

  await assert.rejects(resolve(fixture), installationError('invalid_installation'));
});

async function installationFixture(t: test.TestContext, version: string) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-cli-global-installation-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const globalRoot = join(base, 'lib', 'node_modules');
  const packageRoot = join(globalRoot, 'maka-agent');
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  const manifestUrl = pathToFileURL(join(packageRoot, 'package.json'));
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(homeDir);
  await writeFile(cliPath, '#!/usr/bin/env node\n');
  await writeFile(manifestUrl, JSON.stringify({ name: 'maka-agent', version }));
  return { base, homeDir, globalRoot, packageRoot, cliPath, manifestUrl };
}

function resolve(fixture: Awaited<ReturnType<typeof installationFixture>>) {
  return resolveRuntimeHostNpmGlobalInstallation(
    { manifestUrl: fixture.manifestUrl, homeDir: fixture.homeDir },
    { resolveGlobalNodeModulesRoot: async () => fixture.globalRoot },
  );
}

function installationError(code: RuntimeHostCliInstallationError['code']) {
  return (error: unknown) =>
    error instanceof RuntimeHostCliInstallationError && error.code === code;
}
