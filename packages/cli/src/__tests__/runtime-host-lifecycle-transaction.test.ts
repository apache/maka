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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  beginRuntimeHostManagedDeploymentTransition,
  claimRuntimeHostManagedDeployment,
  readRuntimeHostManagedDeploymentAuthorityRecord,
  resolveRuntimeHostManagedDeploymentConfigPath,
  resolveRuntimeHostNpmDeploymentLayout,
  type RuntimeHostManagedDeploymentConfig,
  type RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import { resolveStorageRoot, tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import type {
  RuntimeHostLifecycleProvider,
  RuntimeHostProviderDefinition,
} from '../runtime-host-lifecycle-provider.js';
import { assertRuntimeHostManagedOperatorConfig } from '../runtime-host-managed-deployment.js';
import {
  applyRuntimeHostLifecycleTransition,
  recoverRuntimeHostLifecycleTransition,
  replaceRuntimeHostLifecycle,
  runtimeHostReconciliationTriggerDefinition,
  runtimeHostSupervisorDefinition,
} from '../runtime-host-lifecycle-transaction.js';

const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const UPDATED_INTEGRITY = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;

test('one authority record recovers provider cutover failures without a journal', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'maka-lifecycle-root-'));
  const authorityRoot = await mkdtemp(join(tmpdir(), 'maka-lifecycle-authority-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  t.after(() => rm(authorityRoot, { recursive: true, force: true }));
  const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const authority = { authorityRoot, durabilityBoundary: authorityRoot };
  const onDemand = config(capability.canonicalPath, capability.rootId, 1, 'on_demand');
  const systemd = config(capability.canonicalPath, capability.rootId, 2, 'systemd_user');
  const launchAgent = {
    ...config(capability.canonicalPath, capability.rootId, 3, 'launch_agent'),
    launch: {
      kind: 'exact_package' as const,
      nodePath: process.execPath,
      package: { kind: 'npm_registry' as const, version: '2.0.0', integrity: UPDATED_INTEGRITY },
    },
  };
  const systemdSupervisor = runtimeHostSupervisorDefinition(systemd);
  assert.deepEqual(systemdSupervisor.command.slice(0, 3), [
    process.execPath,
    resolveRuntimeHostNpmDeploymentLayout(systemd.deploymentRoot, systemd.launch.package.integrity)
      .cliPath,
    'runtime-host',
  ]);
  await claimRuntimeHostManagedDeployment(capability, onDemand, authority);

  const providers = new Map<RuntimeHostSupervisorProvider, FakeLifecycleProvider>([
    ['systemd_user', new FakeLifecycleProvider('systemd_user', 'systemd_timer')],
    ['launch_agent', new FakeLifecycleProvider('launch_agent', 'launch_agent_timer')],
  ]);
  let operatorProjection = onDemand;
  const deps = {
    convergeOperator: async (
      _current: RuntimeHostManagedDeploymentConfig | undefined,
      desired: RuntimeHostManagedDeploymentConfig | undefined,
    ) => {
      if (desired) operatorProjection = desired;
    },
    verifyOperator: async (expected: RuntimeHostManagedDeploymentConfig) => {
      assert.deepEqual(operatorProjection.launch, expected.launch);
    },
    resolveProvider: (provider: RuntimeHostSupervisorProvider) => providers.get(provider)!,
  };
  const firstOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(firstOwner);
  await applyRuntimeHostLifecycleTransition(
    firstOwner,
    { operation: 'lifecycle_change', current: onDemand, desired: systemd },
    deps,
    authority,
  );
  await firstOwner.close();
  assert.deepEqual(
    await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
    systemd,
  );

  const systemdProvider = providers.get('systemd_user')!;
  const launchAgentProvider = providers.get('launch_agent')!;
  const failureBoundaries = ['systemd_timer.uninstall', 'launch_agent_timer.verify'];
  for (const boundary of failureBoundaries) {
    launchAgentProvider.clear();
    systemdProvider.install(systemd);
    FakeLifecycleProvider.failure = boundary;
    const owner = await tryAcquireStateRootOwner(capability);
    assert.ok(owner);
    await assert.rejects(
      applyRuntimeHostLifecycleTransition(
        owner,
        {
          operation: 'provider_change',
          current: systemd,
          desired: launchAgent,
          transactionId: `00000000-0000-4000-8000-${String(failureBoundaries.indexOf(boundary) + 1).padStart(12, '0')}`,
        },
        deps,
        authority,
      ),
    );
    await owner.close();
    assert.deepEqual(
      await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
      systemd,
      boundary,
    );
    systemdProvider.assertInstalled(systemd);
    launchAgentProvider.assertAbsent();
    assert.deepEqual(operatorProjection.launch, systemd.launch);
  }

  const interruptedId = '00000000-0000-4000-8000-000000000099';
  const interruptedOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(interruptedOwner);
  const { record } = await beginRuntimeHostManagedDeploymentTransition(
    interruptedOwner,
    {
      transactionId: interruptedId,
      operation: 'provider_change',
      recovery: 'restore_from',
      expected: systemd,
      desired: launchAgent,
    },
    authority,
  );
  systemdProvider.clear();
  launchAgentProvider.install(launchAgent);
  await interruptedOwner.close();

  const recoveryOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(recoveryOwner);
  await recoverRuntimeHostLifecycleTransition(recoveryOwner, record, deps, authority);
  await recoveryOwner.close();
  assert.deepEqual(
    await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
    systemd,
  );
  systemdProvider.assertInstalled(systemd);
  assert.deepEqual(operatorProjection.launch, systemd.launch);
  launchAgentProvider.assertAbsent();
  assert.throws(
    () =>
      assertRuntimeHostManagedOperatorConfig(
        systemd,
        launchAgent.deploymentId,
        resolveRuntimeHostNpmDeploymentLayout(
          launchAgent.deploymentRoot,
          launchAgent.launch.package.integrity,
        ).cliPath,
      ),
    /different deployment generation or exact package/u,
  );

  const uninstallOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(uninstallOwner);
  await applyRuntimeHostLifecycleTransition(
    uninstallOwner,
    { operation: 'uninstall', current: systemd },
    deps,
    authority,
  );
  await uninstallOwner.close();
  assert.equal(
    await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
    undefined,
  );
  assert.deepEqual(operatorProjection.launch, systemd.launch);

  const migratedSystemd = config(capability.canonicalPath, capability.rootId, 1, 'systemd_user');
  let legacyInstalled = true;
  const legacyDeps = {
    ...deps,
    uninstallLegacy: async () => {
      legacyInstalled = false;
    },
    restoreLegacy: async () => {
      legacyInstalled = true;
    },
  };
  FakeLifecycleProvider.failure = 'systemd_user.converge';
  const failedMigrationOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(failedMigrationOwner);
  await assert.rejects(
    applyRuntimeHostLifecycleTransition(
      failedMigrationOwner,
      { operation: 'legacy_migration', desired: migratedSystemd },
      legacyDeps,
      authority,
    ),
  );
  await failedMigrationOwner.close();
  assert.equal(legacyInstalled, true);
  systemdProvider.assertAbsent();
  assert.equal(
    await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
    undefined,
  );

  const migrationOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(migrationOwner);
  await applyRuntimeHostLifecycleTransition(
    migrationOwner,
    { operation: 'legacy_migration', desired: migratedSystemd },
    legacyDeps,
    authority,
  );
  await migrationOwner.close();
  assert.equal(legacyInstalled, false);
  systemdProvider.assertInstalled(migratedSystemd);

  const migratedUninstallOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(migratedUninstallOwner);
  await applyRuntimeHostLifecycleTransition(
    migratedUninstallOwner,
    { operation: 'uninstall', current: migratedSystemd },
    deps,
    authority,
  );
  await migratedUninstallOwner.close();

  await claimRuntimeHostManagedDeployment(capability, onDemand, authority);
  systemdProvider.clear();
  const uncertainCommitOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(uncertainCommitOwner);
  await assert.rejects(
    applyRuntimeHostLifecycleTransition(
      uncertainCommitOwner,
      { operation: 'lifecycle_change', current: onDemand, desired: systemd },
      deps,
      {
        ...authority,
        beforeDirectorySync: async () => {
          const published = await readRuntimeHostManagedDeploymentAuthorityRecord(
            capability,
            authority,
          );
          if (published?.state === 'active' && published.lifecycle.mode === 'supervised') {
            throw new Error('Injected directory sync failure');
          }
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'deployment_commit_unknown',
  );
  await uncertainCommitOwner.close();
  assert.deepEqual(
    await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
    systemd,
  );
  systemdProvider.assertInstalled(systemd);

  const finalOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(finalOwner);
  await applyRuntimeHostLifecycleTransition(
    finalOwner,
    { operation: 'uninstall', current: systemd },
    deps,
    authority,
  );
  await finalOwner.close();
  assert.ok((await stat(capability.canonicalPath)).isDirectory());
});

test('replacement reactivates a proven previous authority after a pre-commit failure', async (t) => {
  for (const previous of ['supervised', 'legacy'] as const) {
    const stateRoot = await mkdtemp(join(tmpdir(), `maka-lifecycle-${previous}-`));
    const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    const authorityDirectory = dirname(
      resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId),
    );
    t.after(() => rm(stateRoot, { recursive: true, force: true }));
    t.after(() => rm(authorityDirectory, { recursive: true, force: true }));

    const current =
      previous === 'supervised'
        ? config(capability.canonicalPath, capability.rootId, 1, 'systemd_user')
        : undefined;
    if (current) await claimRuntimeHostManagedDeployment(capability, current);
    const desired = config(capability.canonicalPath, capability.rootId, 2, 'on_demand');
    const provider = new FakeLifecycleProvider('systemd_user', 'systemd_timer');
    if (current) provider.install(current);
    let failProjection = true;
    let previousActivations = 0;
    let legacyInstalled = true;
    const deps = {
      convergeOperator: async () => {
        if (!failProjection) return;
        failProjection = false;
        throw new Error('Injected operator projection failure');
      },
      verifyOperator: async () => undefined,
      resolveProvider: () => provider,
      uninstallLegacy: async () => {
        legacyInstalled = false;
      },
      restoreLegacy: async () => {
        legacyInstalled = true;
      },
    };

    await assert.rejects(
      replaceRuntimeHostLifecycle({
        operation: previous === 'legacy' ? 'legacy_migration' : 'lifecycle_change',
        ...(current ? { current } : {}),
        desired,
        activatePrevious: async () => {
          previousActivations += 1;
        },
        deps,
      }),
      { code: 'transition_failed' },
      previous,
    );

    assert.equal(previousActivations, 1, previous);
    assert.deepEqual(
      (await readRuntimeHostManagedDeploymentAuthorityRecord(capability)) ?? undefined,
      current,
      previous,
    );
    if (current) provider.assertInstalled(current);
    else assert.equal(legacyInstalled, true);
  }
});

test('failed on-demand candidate activation restores the known-good package authority', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'maka-lifecycle-on-demand-update-'));
  const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const authorityDirectory = dirname(
    resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  t.after(() => rm(authorityDirectory, { recursive: true, force: true }));

  const current = config(capability.canonicalPath, capability.rootId, 1, 'on_demand');
  const desired = {
    ...current,
    configRevision: 2,
    launch: {
      ...current.launch,
      package: {
        kind: 'npm_registry' as const,
        version: '2.0.0',
        integrity: UPDATED_INTEGRITY,
      },
    },
  };
  await claimRuntimeHostManagedDeployment(capability, current);
  let operatorProjection = current;

  await assert.rejects(
    replaceRuntimeHostLifecycle({
      operation: 'update',
      current,
      desired,
      activateDesired: async () => {
        throw new Error('Injected candidate activation failure');
      },
      deps: {
        convergeOperator: async (_previous, next) => {
          if (next) operatorProjection = next;
        },
        verifyOperator: async () => undefined,
        resolveProvider: () => {
          throw new Error('On-demand replacement must not resolve a supervisor');
        },
      },
    }),
    { code: 'transition_failed' },
  );

  const restored = await readRuntimeHostManagedDeploymentAuthorityRecord(capability);
  assert.equal(restored?.state, 'active');
  assert.equal(restored?.configRevision, 3);
  assert.deepEqual(restored?.launch, current.launch);
  assert.deepEqual(operatorProjection.launch, current.launch);
});

test('interrupted activation compensation completes the previous semantics', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'maka-lifecycle-compensation-root-'));
  const authorityRoot = await mkdtemp(join(tmpdir(), 'maka-lifecycle-compensation-authority-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  t.after(() => rm(authorityRoot, { recursive: true, force: true }));
  const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const authority = { authorityRoot, durabilityBoundary: authorityRoot };
  const previous = config(capability.canonicalPath, capability.rootId, 1, 'systemd_user');
  const failedDesired = config(capability.canonicalPath, capability.rootId, 2, 'on_demand');
  const compensation = { ...previous, configRevision: 3 };
  await claimRuntimeHostManagedDeployment(capability, failedDesired, authority);

  const provider = new FakeLifecycleProvider('systemd_user', 'systemd_timer');
  let operatorProjection = failedDesired;
  const deps = {
    convergeOperator: async (
      _current: RuntimeHostManagedDeploymentConfig | undefined,
      desired: RuntimeHostManagedDeploymentConfig | undefined,
    ) => {
      if (desired) operatorProjection = desired;
    },
    verifyOperator: async () => undefined,
    resolveProvider: () => provider,
  };
  const interruptedOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(interruptedOwner);
  const { record } = await beginRuntimeHostManagedDeploymentTransition(
    interruptedOwner,
    {
      transactionId: '00000000-0000-4000-8000-000000000100',
      operation: 'lifecycle_change',
      recovery: 'complete_to',
      expected: failedDesired,
      desired: compensation,
    },
    authority,
  );
  await interruptedOwner.close();

  const recoveryOwner = await tryAcquireStateRootOwner(capability);
  assert.ok(recoveryOwner);
  const recovered = await recoverRuntimeHostLifecycleTransition(
    recoveryOwner,
    record,
    deps,
    authority,
  );
  await recoveryOwner.close();

  assert.deepEqual(recovered, compensation);
  assert.deepEqual(
    await readRuntimeHostManagedDeploymentAuthorityRecord(capability, authority),
    compensation,
  );
  assert.deepEqual(operatorProjection, compensation);
  provider.assertInstalled(compensation);
});

class FakeLifecycleProvider implements RuntimeHostLifecycleProvider {
  static failure: string | undefined;
  readonly supervisor;
  readonly reconciliationTrigger;
  #supervisorDefinition: RuntimeHostProviderDefinition | undefined;
  #triggerDefinition: RuntimeHostProviderDefinition | undefined;

  constructor(
    supervisorProvider: 'systemd_user' | 'launch_agent',
    triggerProvider: 'systemd_timer' | 'launch_agent_timer',
  ) {
    this.supervisor = {
      provider: supervisorProvider,
      preflight: async () => undefined,
      converge: async (definition: RuntimeHostProviderDefinition) => {
        this.#supervisorDefinition = definition;
        this.#fail(`${supervisorProvider}.converge`);
      },
      verify: async (definition: RuntimeHostProviderDefinition) => {
        assert.deepEqual(this.#supervisorDefinition, definition);
        this.#fail(`${supervisorProvider}.verify`);
      },
      status: async () => ({
        provider: supervisorProvider,
        installed: this.#supervisorDefinition !== undefined,
        enabled: this.#supervisorDefinition !== undefined,
        active: false,
        state: this.#supervisorDefinition ? ('stopped' as const) : ('not_installed' as const),
        pid: null,
        lastExitCode: null,
      }),
      activate: async () => undefined,
      retire: async () => undefined,
      logs: async () => '',
      uninstall: async () => {
        this.#supervisorDefinition = undefined;
        this.#fail(`${supervisorProvider}.uninstall`);
      },
    };
    this.reconciliationTrigger = {
      provider: triggerProvider,
      converge: async (definition: RuntimeHostProviderDefinition) => {
        this.#triggerDefinition = definition;
        this.#fail(`${triggerProvider}.converge`);
      },
      verify: async (definition: RuntimeHostProviderDefinition) => {
        assert.deepEqual(this.#triggerDefinition, definition);
        this.#fail(`${triggerProvider}.verify`);
      },
      status: async () => ({
        installed: this.#triggerDefinition !== undefined,
        active: this.#triggerDefinition !== undefined,
      }),
      activate: async () => undefined,
      logs: async () => '',
      uninstall: async () => {
        this.#triggerDefinition = undefined;
        this.#fail(`${triggerProvider}.uninstall`);
      },
    };
  }

  install(config: RuntimeHostManagedDeploymentConfig): void {
    this.#supervisorDefinition = runtimeHostSupervisorDefinition(config);
    this.#triggerDefinition = runtimeHostReconciliationTriggerDefinition(config);
  }

  clear(): void {
    this.#supervisorDefinition = undefined;
    this.#triggerDefinition = undefined;
  }

  assertInstalled(config: RuntimeHostManagedDeploymentConfig): void {
    assert.deepEqual(this.#supervisorDefinition, runtimeHostSupervisorDefinition(config));
    assert.deepEqual(this.#triggerDefinition, runtimeHostReconciliationTriggerDefinition(config));
  }

  assertAbsent(): void {
    assert.equal(this.#supervisorDefinition, undefined);
    assert.equal(this.#triggerDefinition, undefined);
  }

  #fail(boundary: string): void {
    if (FakeLifecycleProvider.failure !== boundary) return;
    FakeLifecycleProvider.failure = undefined;
    throw new Error(`Injected failure after ${boundary}`);
  }
}

function config(
  rootPath: string,
  rootId: string,
  revision: number,
  lifecycle: 'on_demand' | 'systemd_user' | 'launch_agent',
): RuntimeHostManagedDeploymentConfig {
  const supervised = lifecycle !== 'on_demand';
  return {
    schemaVersion: 1,
    state: 'active',
    deploymentId: '00000000-0000-4000-8000-000000000001',
    configRevision: revision,
    deploymentRoot: '/opt/maka/runtime-host',
    root: { path: rootPath, id: rootId },
    projectDirectoryRoots: [{ label: 'projects', path: '/srv/projects' }],
    launch: {
      kind: 'exact_package',
      nodePath: process.execPath,
      package: { kind: 'npm_registry', version: '1.2.3', integrity: INTEGRITY },
    },
    listeners: {
      localIpc: true,
      websocket: { host: '127.0.0.1', port: 43_210, path: '/runtime-host' },
    },
    lifecycle: supervised
      ? {
          mode: 'supervised',
          provider: lifecycle,
          availability: lifecycle === 'systemd_user' ? 'machine' : 'session',
        }
      : { mode: 'on_demand', availability: 'activation' },
    reconciliation: supervised
      ? {
          trigger: 'scheduled',
          provider: lifecycle === 'systemd_user' ? 'systemd_timer' : 'launch_agent_timer',
        }
      : { trigger: 'activation' },
  };
}
