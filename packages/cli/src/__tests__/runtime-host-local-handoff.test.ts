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
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyLocalHostDeploymentTransition,
  readLocalHostDeploymentRecord,
  type RuntimeHostInstallationOwner,
} from '@maka/runtime-host/operator';
import {
  handoffRuntimeHostNpmGlobalDeployment,
  resolveRuntimeHostLocalCliDeploymentRoot,
  RuntimeHostLocalHandoffError,
  stageRuntimeHostNpmGlobalDeploymentTarget,
} from '../runtime-host-local-handoff.js';
import { prepareRuntimeHostPackageDeployment } from '../runtime-host-package-deployment.js';

const ROOT_ID = 'a'.repeat(64);
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const TARGET = {
  kind: 'npm_registry' as const,
  version: '2.0.0',
  integrity: INTEGRITY,
};
const CLI_OWNER = {
  kind: 'cli' as const,
  installationId: 'npm-global:stable-slot',
};
const DESKTOP_OWNER: RuntimeHostInstallationOwner = {
  kind: 'desktop',
  installationId: 'desktop:stable',
};
const PREVIOUS = {
  kind: 'npm_registry' as const,
  version: '1.0.0',
  integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
};

test('local CLI deployment roots are stable for one OS account and isolated by owner and root', () => {
  const first = resolveRuntimeHostLocalCliDeploymentRoot(ROOT_ID, CLI_OWNER, {
    platform: 'linux',
    homeDir: '/home/maka',
  });
  assert.equal(
    resolveRuntimeHostLocalCliDeploymentRoot(ROOT_ID, CLI_OWNER, {
      platform: 'linux',
      homeDir: '/home/maka',
    }),
    first,
  );
  assert.match(first, /^\/home\/maka\/\.local\/share\/Maka\/runtime-host-deployments\/cli\//u);
  assert.notEqual(
    resolveRuntimeHostLocalCliDeploymentRoot(
      ROOT_ID,
      { ...CLI_OWNER, installationId: 'npm-global:other-slot' },
      { platform: 'linux', homeDir: '/home/maka' },
    ),
    first,
  );
  assert.notEqual(
    resolveRuntimeHostLocalCliDeploymentRoot('b'.repeat(64), CLI_OWNER, {
      platform: 'linux',
      homeDir: '/home/maka',
    }),
    first,
  );
});

test('exact registry evidence becomes a persistent transaction-fenced Host candidate', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-handoff-stage-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, TARGET.version);
  const pathOptions = { platform: 'linux' as const, homeDir: join(base, 'home') };
  const staged = await stageRuntimeHostNpmGlobalDeploymentTarget(
    {
      rootId: ROOT_ID,
      owner: CLI_OWNER,
      target: TARGET,
      transactionId: 'transaction-one',
    },
    pathOptions,
    {
      withPackage: async (candidate, use) => {
        assert.deepEqual(candidate, TARGET);
        return use(sourcePackageRoot);
      },
      prepareDeployment: prepareRuntimeHostPackageDeployment,
    },
  );

  await rm(sourcePackageRoot, { recursive: true, force: true });
  assert.equal((await stat(staged.candidateEntrypoint)).isFile(), true);
  assert.match(staged.root, /runtime-host-deployments\/cli/u);
  assert.match(staged.root, new RegExp(`${ROOT_ID}$`, 'u'));
  assert.match(staged.packageRoot, /registry-[a-f0-9]{64}$/u);
  assert.match(staged.launchGeneration, /^npm-global-handoff:[a-f0-9]{64}$/u);

  const retried = await stageRuntimeHostNpmGlobalDeploymentTarget(
    {
      rootId: ROOT_ID,
      owner: CLI_OWNER,
      target: TARGET,
      transactionId: 'transaction-one',
    },
    pathOptions,
    {
      withPackage: async (_candidate, use) => use(staged.packageRoot),
      prepareDeployment: prepareRuntimeHostPackageDeployment,
    },
  );
  assert.equal(retried.packageRoot, staged.packageRoot);
  assert.equal(retried.launchGeneration, staged.launchGeneration);
});

test('npm-global handoff stages before the one durable owner transaction', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-handoff-compose-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  assert.equal(claimed.kind, 'applied');
  const events: string[] = [];

  const result = await handoffRuntimeHostNpmGlobalDeployment(
    {
      rootId: ROOT_ID,
      expectedRevision: claimed.record!.revision,
      transactionId: 'desktop-to-cli',
      from: DESKTOP_OWNER,
      target: TARGET,
      activeWorkPolicy: 'refuse_active_work',
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    {
      async prepareHostCutover(rootId, _selected, target, staged, policy) {
        const intent = await readLocalHostDeploymentRecord(rootId, { authorityRoot });
        assert.equal(intent?.state.kind, 'handoff');
        assert.equal((await stat(staged.candidateEntrypoint)).isFile(), true);
        assert.deepEqual(target, TARGET);
        events.push(`retire:${policy}`);
        return { kind: 'target_absent' };
      },
      async observeWriterRelease() {
        events.push('writer-released');
      },
      async activateTarget(_rootId, staged) {
        events.push(`activate:${staged.launchGeneration}`);
      },
      async verifyTargetReady(_rootId, target, staged) {
        assert.deepEqual(target, TARGET);
        assert.equal((await stat(staged.candidateEntrypoint)).isFile(), true);
        events.push('ready');
      },
    },
    { authorityRoot },
    {
      resolveInstallation: async () => ({
        owner: CLI_OWNER,
        observedRelease: {
          version: TARGET.version,
          packageRoot: sourcePackageRoot,
          cliPath: join(sourcePackageRoot, 'dist', 'cli.js'),
        },
      }),
      withPackage: async (_candidate, use) => use(sourcePackageRoot),
      prepareDeployment: prepareRuntimeHostPackageDeployment,
    },
  );

  assert.equal(result.kind, 'completed');
  assert.equal(events.length, 4);
  assert.equal(events[0], 'retire:refuse_active_work');
  assert.equal(events[1], 'writer-released');
  assert.match(events[2] ?? '', /^activate:npm-global-handoff:/u);
  assert.equal(events[3], 'ready');
  assert.equal(result.record.state.kind, 'owned');
  assert.deepEqual(result.record.state.owner, CLI_OWNER);
  assert.deepEqual(result.record.state.selected, TARGET);
});

test('package verification failure leaves deployment authority unchanged', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-handoff-stage-failure-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authorityRoot = join(base, 'authority');
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  assert.equal(claimed.kind, 'applied');

  await assert.rejects(
    handoffRuntimeHostNpmGlobalDeployment(
      {
        rootId: ROOT_ID,
        expectedRevision: claimed.record!.revision,
        transactionId: 'failed-staging',
        from: DESKTOP_OWNER,
        target: TARGET,
        activeWorkPolicy: 'refuse_active_work',
        deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
      },
      {
        prepareHostCutover: async () => assert.fail('retirement must not begin'),
        observeWriterRelease: async () => assert.fail('writer observation must not begin'),
        activateTarget: async () => assert.fail('activation must not begin'),
        verifyTargetReady: async () => assert.fail('Ready verification must not begin'),
      },
      { authorityRoot },
      {
        resolveInstallation: async () => ({
          owner: CLI_OWNER,
          observedRelease: {
            version: TARGET.version,
            packageRoot: base,
            cliPath: join(base, 'dist', 'cli.js'),
          },
        }),
        withPackage: async () => {
          throw new Error('registry verification failed');
        },
      },
    ),
    /registry verification failed/u,
  );
  assert.deepEqual(await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot }), claimed.record);
});

test('installed release skew is rejected before staging or authority mutation', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-handoff-installation-skew-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authorityRoot = join(base, 'authority');
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  assert.equal(claimed.kind, 'applied');
  let staged = false;

  await assert.rejects(
    handoffRuntimeHostNpmGlobalDeployment(
      {
        rootId: ROOT_ID,
        expectedRevision: claimed.record!.revision,
        transactionId: 'stale-installed-release',
        from: DESKTOP_OWNER,
        target: TARGET,
        activeWorkPolicy: 'refuse_active_work',
      },
      {
        prepareHostCutover: async () => assert.fail('retirement must not begin'),
        observeWriterRelease: async () => assert.fail('writer observation must not begin'),
        activateTarget: async () => assert.fail('activation must not begin'),
        verifyTargetReady: async () => assert.fail('Ready verification must not begin'),
      },
      { authorityRoot },
      {
        resolveInstallation: async () => ({
          owner: CLI_OWNER,
          observedRelease: {
            version: '2.1.0',
            packageRoot: base,
            cliPath: join(base, 'dist', 'cli.js'),
          },
        }),
        withPackage: async () => {
          staged = true;
          throw new Error('must not stage');
        },
      },
    ),
    (error: unknown) =>
      error instanceof RuntimeHostLocalHandoffError && error.code === 'installed_release_mismatch',
  );
  assert.equal(staged, false);
  assert.deepEqual(await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot }), claimed.record);
});

async function selfContainedPackage(base: string, version: string): Promise<string> {
  const root = join(base, `source-${version}`);
  const runtimeHostRoot = join(root, 'node_modules', '@maka', 'runtime-host');
  await Promise.all([
    mkdir(join(root, 'dist'), { recursive: true }),
    mkdir(join(runtimeHostRoot, 'dist'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maka-agent', version })),
    writeFile(join(root, 'dist', 'cli.js'), ''),
    writeFile(join(runtimeHostRoot, 'package.json'), '{}'),
    writeFile(join(runtimeHostRoot, 'dist', 'execution-candidate-main.js'), ''),
  ]);
  return root;
}
