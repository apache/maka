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
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import {
  reconcileRuntimeHostNpmGlobalDeployment,
  resolveRuntimeHostLocalCliDeploymentRoot,
  restartRuntimeHostNpmGlobalDeployment,
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

  const result = await reconcileRuntimeHostNpmGlobalDeployment(
    {
      rootId: ROOT_ID,
      transactionId: 'desktop-to-cli',
      target: TARGET,
      activeWorkPolicy: 'refuse_active_work',
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    {
      prepareUnownedHostCutover: async () => assert.fail('owner record already exists'),
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
    reconcileRuntimeHostNpmGlobalDeployment(
      {
        rootId: ROOT_ID,
        transactionId: 'failed-staging',
        target: TARGET,
        activeWorkPolicy: 'refuse_active_work',
        deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
      },
      {
        prepareUnownedHostCutover: async () => assert.fail('cutover must not begin'),
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
    reconcileRuntimeHostNpmGlobalDeployment(
      {
        rootId: ROOT_ID,
        transactionId: 'stale-installed-release',
        target: TARGET,
        activeWorkPolicy: 'refuse_active_work',
      },
      {
        prepareUnownedHostCutover: async () => assert.fail('cutover must not begin'),
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

test('explicit npm-global restart claims an exact staged legacy takeover', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-restart-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  let closed = 0;
  let launchedEntrypoint = '';

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
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
      resolveCandidate: async () => TARGET,
      withPackage: async (_candidate, use) => use(sourcePackageRoot),
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(hostRegistration()),
      activateTarget: async (input) => {
        launchedEntrypoint = input.staged.candidateEntrypoint;
        return {
          kind: 'ready',
          settle: async () => {
            closed += 1;
          },
        };
      },
    },
  );

  assert.equal(result.kind, 'completed');
  assert.match(launchedEntrypoint, /execution-candidate-main\.js$/u);
  assert.equal(closed >= 1, true);
  const record = await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot });
  assert.deepEqual(record?.state, { kind: 'owned', owner: CLI_OWNER, selected: TARGET });
});

test('legacy restart reports active work without claiming deployment authority', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-restart-active-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  const observed = hostRegistration();

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: observed,
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
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
      resolveCandidate: async () => TARGET,
      withPackage: async (_candidate, use) => use(sourcePackageRoot),
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(observed),
      activateTarget: async () => ({
        kind: 'active_work',
        settle: async () => undefined,
      }),
    },
  );

  assert.equal(result.kind, 'active_work');
  assert.equal(await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot }), undefined);
});

test('external npm replacement retires through the exact source package and commits the target', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-reconcile-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, PREVIOUS.version, {
    sourceRetirementHelper: true,
  });
  const targetPackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  await stageSelectedPackage(base, sourcePackageRoot);
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  assert.equal(claimed.kind, 'applied');
  const events: string[] = [];

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
      activeWorkPolicy: 'interrupt_active_work',
    },
    { authorityRoot },
    {
      resolveInstallation: async () => ({
        owner: CLI_OWNER,
        observedRelease: {
          version: TARGET.version,
          packageRoot: targetPackageRoot,
          cliPath: join(targetPackageRoot, 'dist', 'cli.js'),
        },
      }),
      resolveCandidate: async () => TARGET,
      withPackage: async (candidate, use) => {
        assert.equal(candidate.version, TARGET.version);
        return use(targetPackageRoot);
      },
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(hostRegistration()),
      retireSource: async (input) => {
        assert.match(input.sourceCliPath, /registry-[a-f0-9]{64}\/dist\/cli\.js$/u);
        assert.equal(input.expectedHostEpoch, 'old-host');
        assert.equal(input.activeWorkPolicy, 'interrupt_active_work');
        events.push('source-retired');
        return 'prepared';
      },
      activateTarget: async (input) => {
        assert.equal(input.target.version, TARGET.version);
        events.push('target-ready');
        return {
          kind: 'ready',
          settle: async () => {
            events.push('settled');
          },
        };
      },
    },
  );

  assert.equal(result.kind, 'completed');
  assert.deepEqual(events, ['source-retired', 'target-ready', 'settled']);
  const record = await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot });
  assert.equal(record?.state.kind, 'owned');
  assert.deepEqual(record?.state.selected, TARGET);
});

test('external source active work rolls back without launching the target', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-active-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, PREVIOUS.version, {
    sourceRetirementHelper: true,
  });
  const targetPackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  await stageSelectedPackage(base, sourcePackageRoot);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    { authorityRoot },
    {
      resolveInstallation: async () => ({
        owner: CLI_OWNER,
        observedRelease: {
          version: TARGET.version,
          packageRoot: targetPackageRoot,
          cliPath: join(targetPackageRoot, 'dist', 'cli.js'),
        },
      }),
      resolveCandidate: async () => TARGET,
      withPackage: async (candidate, use) => {
        assert.equal(candidate.version, TARGET.version);
        return use(targetPackageRoot);
      },
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(hostRegistration()),
      retireSource: async () => 'active_work',
      activateTarget: async () => assert.fail('active source work must prevent target activation'),
    },
  );

  assert.equal(result.kind, 'active_work');
  const record = await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot });
  assert.deepEqual(record?.state, { kind: 'owned', owner: CLI_OWNER, selected: PREVIOUS });
});

test('pre-helper source release keeps the bounded idle-only takeover path', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-pre-helper-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, PREVIOUS.version);
  const targetPackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  await stageSelectedPackage(base, sourcePackageRoot);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  let takeoverHostEpoch: string | undefined;

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    { authorityRoot },
    {
      resolveInstallation: async () => ({
        owner: CLI_OWNER,
        observedRelease: {
          version: TARGET.version,
          packageRoot: targetPackageRoot,
          cliPath: join(targetPackageRoot, 'dist', 'cli.js'),
        },
      }),
      resolveCandidate: async () => TARGET,
      withPackage: async (candidate, use) => {
        assert.equal(candidate.version, TARGET.version);
        return use(targetPackageRoot);
      },
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(hostRegistration()),
      retireSource: async () => assert.fail('a pre-helper source must not run the new helper'),
      activateTarget: async (input) => {
        takeoverHostEpoch = input.takeoverHostEpoch;
        return { kind: 'ready', settle: async () => undefined };
      },
    },
  );

  assert.equal(result.kind, 'completed');
  assert.equal(takeoverHostEpoch, 'old-host');
});

test('source helper failure preserves the durable handoff for recovery', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-helper-failure-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, PREVIOUS.version, {
    sourceRetirementHelper: true,
  });
  const targetPackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  await stageSelectedPackage(base, sourcePackageRoot);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    { authorityRoot },
    {
      resolveInstallation: async () => ({
        owner: CLI_OWNER,
        observedRelease: {
          version: TARGET.version,
          packageRoot: targetPackageRoot,
          cliPath: join(targetPackageRoot, 'dist', 'cli.js'),
        },
      }),
      resolveCandidate: async () => TARGET,
      withPackage: async (candidate, use) => {
        assert.equal(candidate.version, TARGET.version);
        return use(targetPackageRoot);
      },
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(hostRegistration()),
      retireSource: async () => {
        throw new Error('source helper exited');
      },
      activateTarget: async () => assert.fail('a failed source helper must not launch the target'),
    },
  );

  assert.equal(result.kind, 'recovery_required');
  assert.equal(
    result.kind === 'recovery_required' ? result.phase : undefined,
    'prepare_host_cutover',
  );
  assert.equal(
    (await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot }))?.state.kind,
    'handoff',
  );
});

test('a Host epoch change after confirmation cannot retire the replacement process', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-host-race-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, PREVIOUS.version, {
    sourceRetirementHelper: true,
  });
  const targetPackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  await stageSelectedPackage(base, sourcePackageRoot);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    { authorityRoot },
    {
      resolveInstallation: async () => ({
        owner: CLI_OWNER,
        observedRelease: {
          version: TARGET.version,
          packageRoot: targetPackageRoot,
          cliPath: join(targetPackageRoot, 'dist', 'cli.js'),
        },
      }),
      resolveCandidate: async () => TARGET,
      withPackage: async (_candidate, use) => use(targetPackageRoot),
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () =>
        incompatibleHost(hostRegistration({ hostEpoch: 'replacement-host' })),
      retireSource: async () => assert.fail('an unconfirmed replacement Host must not retire'),
      activateTarget: async () => assert.fail('an unconfirmed replacement Host must remain'),
    },
  );

  assert.equal(result.kind, 'recovery_required');
  assert.equal(
    result.kind === 'recovery_required' ? result.phase : undefined,
    'prepare_host_cutover',
  );
  assert.equal(
    (await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot }))?.state.kind,
    'handoff',
  );
});

test('external reconciliation asks the activator to adjudicate when npm changes again', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-installation-race-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourcePackageRoot = await selfContainedPackage(base, PREVIOUS.version, {
    sourceRetirementHelper: true,
  });
  const targetPackageRoot = await selfContainedPackage(base, TARGET.version);
  const authorityRoot = join(base, 'authority');
  await stageSelectedPackage(base, sourcePackageRoot);
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  let installationReads = 0;
  let settlementRequested = false;

  const result = await restartRuntimeHostNpmGlobalDeployment(
    {
      rootPath: join(base, 'root'),
      registration: hostRegistration(),
      deploymentPathOptions: { platform: 'linux', homeDir: join(base, 'home') },
    },
    { authorityRoot },
    {
      resolveInstallation: async () => {
        installationReads += 1;
        return {
          owner: CLI_OWNER,
          observedRelease: {
            version: installationReads === 1 ? TARGET.version : '3.0.0',
            packageRoot: targetPackageRoot,
            cliPath: join(targetPackageRoot, 'dist', 'cli.js'),
          },
        };
      },
      resolveCandidate: async () => TARGET,
      withPackage: async (candidate, use) => {
        assert.equal(candidate.version, TARGET.version);
        return use(targetPackageRoot);
      },
      prepareDeployment: prepareRuntimeHostPackageDeployment,
      connectExisting: async () => incompatibleHost(hostRegistration()),
      retireSource: async () => 'prepared',
      activateTarget: async () => ({
        kind: 'ready',
        settle: async () => {
          settlementRequested = true;
        },
      }),
    },
  );

  assert.equal(result.kind, 'recovery_required');
  assert.equal(result.kind === 'recovery_required' ? result.phase : undefined, 'finalize_target');
  assert.equal(settlementRequested, true);
  assert.equal(
    (await readLocalHostDeploymentRecord(ROOT_ID, { authorityRoot }))?.state.kind,
    'handoff',
  );
});

test('local restart keeps service Hosts under operator authority', async () => {
  assert.deepEqual(
    await restartRuntimeHostNpmGlobalDeployment({
      rootPath: '/managed-root',
      registration: hostRegistration({ lifecycleMode: 'service' }),
    }),
    { kind: 'operator_required', reason: 'service_host' },
  );
  assert.deepEqual(
    await restartRuntimeHostNpmGlobalDeployment({
      rootPath: '/legacy-root',
      registration: hostRegistration({ lifecycleMode: undefined }),
    }),
    { kind: 'operator_required', reason: 'unowned_host' },
  );
});

test('committed target conflicting with the observed Host fails closed', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-restart-observation-conflict-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authorityRoot = join(base, 'authority');
  const claimed = await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: TARGET },
    { authorityRoot },
  );
  assert.equal(claimed.kind, 'applied');

  await assert.rejects(
    restartRuntimeHostNpmGlobalDeployment(
      { rootPath: join(base, 'root'), registration: hostRegistration() },
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
        resolveCandidate: async () => TARGET,
        withPackage: async () => assert.fail('conflicting committed target must not be staged'),
      },
    ),
    (error: unknown) =>
      error instanceof RuntimeHostLocalHandoffError &&
      error.code === 'selected_target_observation_conflict',
  );
});

test('external npm replacement rejects a different durable source owner before staging', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-owner-mismatch-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authorityRoot = join(base, 'authority');
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: DESKTOP_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );

  await assert.rejects(
    restartRuntimeHostNpmGlobalDeployment(
      { rootPath: join(base, 'root'), registration: hostRegistration() },
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
        resolveCandidate: async () => assert.fail('cross-owner replacement must not resolve'),
        withPackage: async () => assert.fail('cross-owner replacement must not stage a target'),
        connectExisting: async () => assert.fail('cross-owner replacement must not observe a Host'),
      },
    ),
    (error: unknown) =>
      error instanceof RuntimeHostLocalHandoffError && error.code === 'source_owner_mismatch',
  );
});

test('external npm downgrade is rejected before staging or retirement', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-external-downgrade-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authorityRoot = join(base, 'authority');
  await applyLocalHostDeploymentTransition(
    ROOT_ID,
    { kind: 'claim', owner: CLI_OWNER, selected: PREVIOUS },
    { authorityRoot },
  );
  const downgrade = {
    kind: 'npm_registry' as const,
    version: '0.9.0',
    integrity: `sha512-${Buffer.alloc(64, 9).toString('base64')}`,
  };

  await assert.rejects(
    restartRuntimeHostNpmGlobalDeployment(
      { rootPath: join(base, 'root'), registration: hostRegistration() },
      { authorityRoot },
      {
        resolveInstallation: async () => ({
          owner: CLI_OWNER,
          observedRelease: {
            version: downgrade.version,
            packageRoot: base,
            cliPath: join(base, 'dist', 'cli.js'),
          },
        }),
        resolveCandidate: async () => downgrade,
        withPackage: async () => assert.fail('a downgrade must not be staged'),
      },
    ),
    (error: unknown) =>
      error instanceof RuntimeHostLocalHandoffError && error.code === 'unsupported_downgrade',
  );
});

async function stageSelectedPackage(base: string, sourcePackageRoot: string): Promise<void> {
  await stageRuntimeHostNpmGlobalDeploymentTarget(
    {
      rootId: ROOT_ID,
      owner: CLI_OWNER,
      target: PREVIOUS,
      transactionId: 'selected-source',
    },
    { platform: 'linux', homeDir: join(base, 'home') },
    {
      withPackage: async (_candidate, use) => use(sourcePackageRoot),
      prepareDeployment: prepareRuntimeHostPackageDeployment,
    },
  );
}

async function selfContainedPackage(
  base: string,
  version: string,
  options: { readonly sourceRetirementHelper?: boolean } = {},
): Promise<string> {
  const root = join(base, `source-${version}`);
  const runtimeHostRoot = join(root, 'node_modules', '@maka', 'runtime-host');
  await Promise.all([
    mkdir(join(root, 'dist'), { recursive: true }),
    mkdir(join(runtimeHostRoot, 'dist'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maka-agent', version })),
    writeFile(join(root, 'dist', 'cli.js'), ''),
    ...(options.sourceRetirementHelper
      ? [writeFile(join(root, 'dist', 'runtime-host-local-source-retirement.js'), '')]
      : []),
    writeFile(join(runtimeHostRoot, 'package.json'), '{}'),
    writeFile(join(runtimeHostRoot, 'dist', 'execution-candidate-main.js'), ''),
  ]);
  return root;
}

function hostRegistration(overrides: Partial<HostRegistration> = {}): HostRegistration {
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: ROOT_ID,
    hostEpoch: 'old-host',
    endpoint: '/tmp/maka-host.sock',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'legacy',
    lifecycleMode: 'ephemeral',
    state: 'ready',
    pid: 42,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function incompatibleHost(registration: HostRegistration) {
  return {
    kind: 'incompatible' as const,
    registration,
    handshake: {
      kind: 'incompatible' as const,
      hostEpoch: registration.hostEpoch,
      protocolMin: 0,
      protocolMax: 0,
      compatibilityEpoch: registration.compatibilityEpoch,
      compositionId: registration.compositionId,
      compositionRevision: registration.compositionRevision,
      state: 'ready' as const,
      replacement: 'blocked_by_residency' as const,
    },
  };
}
