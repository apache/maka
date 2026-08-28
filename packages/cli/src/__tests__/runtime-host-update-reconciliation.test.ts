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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  decodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import {
  runManagedRuntimeHostUpdatePolicyCli,
  runManagedRuntimeHostUpdateReconcileCli,
} from '../runtime-host-update-reconciliation.js';
import { RuntimeHostServiceManagerError } from '../runtime-host-service-manager.js';
import {
  readRuntimeHostManagedUpdatePolicy,
  resolveRuntimeHostManagedUpdatePolicyPath,
  RuntimeHostUpdatePolicyError,
  writeRuntimeHostManagedUpdatePolicy,
} from '../runtime-host-update-policy-store.js';

const INTEGRITY =
  'sha512-jUKdo/5dbM94KXq+kOZ1d+obhDLAENfI/QWr1PnXWcdu2PqDyLklJBtiVO6HRwoL1l40z1NE9Rq+hLAxCN0Fyg==';
const TARGET = {
  serviceId: 'b'.repeat(64),
  rootPath: '/srv/maka-link',
  rootId: 'a'.repeat(64),
};
const OPERATOR_DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';
const SERVICE = {
  platform: 'linux',
  arch: 'x64',
  osRelease: 'test',
  state: 'running' as const,
  pid: 42,
  lastExitCode: null,
  installedVersion: '1.0.0',
  stateRoot: '/srv/maka',
  projectDirectoryRoots: [],
};

describe('managed Runtime Host update reconciliation', () => {
  it('parses the coordinator-supervised installed-update activator contract', () => {
    const argv = [
      'local-update-activate',
      '--root',
      '/srv/maka',
      '--expected-root-id',
      TARGET.rootId,
      '--generation',
      'update-generation',
      '--candidate-entrypoint',
      '/srv/staged/host.js',
      '--await-coordinator-commit',
      'true',
      '--expected-owner-installation-id',
      'npm-global:slot',
      '--target-version',
      '2.0.0',
      '--target-integrity',
      INTEGRITY,
    ];
    assert.deepEqual(parseRuntimeHostCommand(argv), {
      kind: 'runtime-host-local-update-activate',
      rootPath: '/srv/maka',
      expectedRootId: TARGET.rootId,
      generation: 'update-generation',
      candidateEntrypoint: '/srv/staged/host.js',
      awaitCoordinatorCommit: true,
      expectedOwnerInstallationId: 'npm-global:slot',
      targetVersion: '2.0.0',
      targetIntegrity: INTEGRITY,
    });
    const disabled = [...argv];
    disabled[disabled.indexOf('true')] = 'false';
    for (const invalid of [
      argv.filter((value) => value !== '--target-integrity' && value !== INTEGRITY),
      disabled,
      ['local-update-activate', ...argv.slice(1), '--target-version', '2.0.0'],
    ]) {
      assert.equal(parseRuntimeHostCommand(invalid).kind, 'error');
    }
  });

  it('parses update policy and reconciliation commands against an optional expected target', () => {
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'update-policy',
        '--target',
        'next',
        '--expected-service-id',
        TARGET.serviceId,
        '--expected-root-path',
        TARGET.rootPath,
        '--expected-root-id',
        TARGET.rootId,
        '--operator-deployment-id',
        OPERATOR_DEPLOYMENT_ID,
      ]),
      {
        kind: 'runtime-host-service-update-policy',
        json: false,
        policy: { kind: 'channel', channel: 'next' },
        expectedTarget: TARGET,
        operatorDeploymentId: OPERATOR_DEPLOYMENT_ID,
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'reconcile-update',
        '--json',
        '--expected-service-id',
        TARGET.serviceId,
        '--expected-root-path',
        TARGET.rootPath,
        '--expected-root-id',
        TARGET.rootId,
        '--operator-deployment-id',
        OPERATOR_DEPLOYMENT_ID,
      ]),
      {
        kind: 'runtime-host-service-reconcile-update',
        json: true,
        expectedTarget: TARGET,
        operatorDeploymentId: OPERATOR_DEPLOYMENT_ID,
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'update-policy',
        '--target',
        'manual',
        '--expected-service-id',
        TARGET.serviceId,
        '--expected-root-path',
        TARGET.rootPath,
        '--expected-root-id',
        TARGET.rootId,
      ]),
      {
        kind: 'runtime-host-service-update-policy',
        json: false,
        policy: { kind: 'manual' },
        expectedTarget: TARGET,
      },
    );
    assert.equal(
      parseRuntimeHostCommand(['service', 'update-policy', '--target', 'latest']).kind,
      'error',
    );
    assert.equal(
      (
        parseRuntimeHostCommand([
          'service',
          'check-update',
          '--target',
          'latest',
          '--operator-deployment-id',
          OPERATOR_DEPLOYMENT_ID,
        ]) as { readonly operatorDeploymentId?: string }
      ).operatorDeploymentId,
      OPERATOR_DEPLOYMENT_ID,
    );
  });

  it('persists an automatic policy against the canonical managed target and removes manual state', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-policy-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    const deploymentRoot = join(clientDataRoot, 'managed');
    const common = {
      json: true,
      framed: false,
      clientDataRoot,
      defaultRootPath: '/workspace',
      operatorDeploymentId: OPERATOR_DEPLOYMENT_ID,
    };
    let output = '';
    const manage = async () => managedStatus(deploymentRoot);
    assert.equal(
      await runManagedRuntimeHostUpdatePolicyCli(
        {
          ...common,
          policy: { kind: 'fixed', version: '2.0.0' },
          expectedTarget: TARGET,
        },
        {
          withDeploymentLock: async (_root, operation) => operation(),
          createBackend: () => unusedBackend(),
          manage,
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      0,
    );
    assert.deepEqual(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), {
      schemaVersion: 1,
      policy: { kind: 'fixed', version: '2.0.0' },
      target: {
        ...TARGET,
        rootPath: '/srv/maka',
        deploymentId: OPERATOR_DEPLOYMENT_ID,
      },
    });
    assert.equal(JSON.parse(output).updatePolicy.policy.kind, 'fixed');

    assert.equal(
      await runManagedRuntimeHostUpdatePolicyCli(
        { ...common, policy: { kind: 'manual' }, expectedTarget: TARGET },
        {
          withDeploymentLock: async (_root, operation) => operation(),
          manage,
          createBackend: () => unusedBackend(),
          writeOutput: () => undefined,
        },
      ),
      0,
    );
    assert.equal(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), null);
    const previousCapabilityRequest = process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY;
    t.after(() => {
      if (previousCapabilityRequest === undefined) {
        delete process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
      } else {
        process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] = previousCapabilityRequest;
      }
    });
    let manualOutput = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { ...common, json: false, framed: true },
        {
          manage,
          createBackend: () => unusedBackend(),
          resolveSelection: async () => assert.fail('manual policy must not resolve a target'),
          writeOutput: (value) => {
            manualOutput += value;
          },
        },
      ),
      0,
    );
    const manualFrame = decodeRuntimeHostServiceManagementFrame(manualOutput.trim());
    assert.equal(
      manualFrame?.kind === 'result' && manualFrame.action === 'reconcile_update'
        ? manualFrame.reconciliation.kind
        : undefined,
      'disabled',
    );
    assert.equal(
      manualFrame?.kind === 'result' && manualFrame.action === 'reconcile_update'
        ? manualFrame.updateSchedulerState
        : undefined,
      'ready',
    );
  });

  it('fences policy reads and reports a drifted update scheduler', async (t) => {
    const previousCapabilityRequest = process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
    process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] =
      RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY;
    t.after(() => {
      if (previousCapabilityRequest === undefined) {
        delete process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
      } else {
        process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] = previousCapabilityRequest;
      }
    });
    let locked = false;
    let output = '';
    assert.equal(
      await runManagedRuntimeHostUpdatePolicyCli(
        {
          json: true,
          framed: false,
          clientDataRoot: '/client',
          defaultRootPath: '/workspace',
          expectedTarget: TARGET,
        },
        {
          withDeploymentLock: async (_root, operation) => {
            locked = true;
            try {
              return await operation();
            } finally {
              locked = false;
            }
          },
          manage: async (input) => {
            assert.equal(locked, true);
            assert.deepEqual(input.expectedTarget, TARGET);
            return managedStatus('/managed');
          },
          readPolicy: async () => null,
          createBackend: () => ({
            ...unusedBackend(),
            verifyDeployment: async () => {
              throw new RuntimeHostServiceManagerError(
                'target_mismatch',
                'Update scheduler is not loaded',
              );
            },
          }),
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      0,
    );
    assert.equal(JSON.parse(output).updateSchedulerState, 'needs_repair');
  });

  it('distinguishes an uncertain policy commit and makes an absent-policy retry durable', async (t) => {
    const deploymentRoot = await mkdtemp(join(tmpdir(), 'maka-update-policy-commit-'));
    t.after(() => rm(deploymentRoot, { recursive: true, force: true }));
    const record = {
      schemaVersion: 1 as const,
      policy: { kind: 'fixed' as const, version: '2.0.0' },
      target: TARGET,
    };
    const failSync = async () => {
      throw new Error('directory sync failed');
    };

    await assert.rejects(
      writeRuntimeHostManagedUpdatePolicy(deploymentRoot, record, { syncDirectory: failSync }),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePolicyError &&
        error.code === 'update_policy_commit_outcome_unknown',
    );
    assert.deepEqual(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), record);

    await assert.rejects(
      writeRuntimeHostManagedUpdatePolicy(deploymentRoot, null, { syncDirectory: failSync }),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePolicyError &&
        error.code === 'update_policy_commit_outcome_unknown',
    );
    assert.equal(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), null);
    let syncs = 0;
    await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, null, {
      syncDirectory: async () => {
        syncs += 1;
      },
    });
    assert.equal(syncs, 1);
  });

  it('resolves one policy snapshot and delegates an admitted exact target to the update transaction', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-reconcile-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    const deploymentRoot = join(clientDataRoot, 'managed');
    await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, {
      schemaVersion: 1,
      policy: { kind: 'fixed', version: '2.0.0' },
      target: TARGET,
    });
    let output = '';
    let applied = false;
    const exitCode = await runManagedRuntimeHostUpdateReconcileCli(
      {
        json: true,
        framed: false,
        clientDataRoot,
        defaultRootPath: '/workspace',
      },
      {
        manage: async () => managedStatus(deploymentRoot),
        createBackend: () => unusedBackend(),
        resolveSelection: async (options) => {
          assert.deepEqual(options.selector, { kind: 'exact', version: '2.0.0' });
          assert.deepEqual(options.expectedTarget, TARGET);
          return {
            selector: options.selector,
            candidate: {
              kind: 'npm_registry',
              version: '2.0.0',
              integrity: INTEGRITY,
              compatibility: 1,
            },
            outcome: { kind: 'unattended_update', compatibility: 1 },
            currentCliPath: '/managed/current/cli.js',
            service: SERVICE,
          };
        },
        applySelection: async (_options, _selection, overrides, emit) => {
          assert.equal(await overrides?.revalidateSelection?.(), undefined);
          applied = true;
          emit?.({
            schemaVersion: 1,
            kind: 'progress',
            action: 'update',
            phase: 'checking',
            currentVersion: '1.0.0',
            targetVersion: '2.0.0',
          });
          emit?.({
            schemaVersion: 1,
            kind: 'result',
            action: 'update',
            service: { ...SERVICE, installedVersion: '2.0.0' },
            update: {
              kind: 'updated',
              previousVersion: '1.0.0',
              targetVersion: '2.0.0',
            },
          });
          return 0;
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(applied, true);
    const frame = JSON.parse(output) as RuntimeHostServiceManagementFrame;
    assert.equal(frame.action, 'reconcile_update');
    assert.deepEqual(
      frame.kind === 'result' && frame.action === 'reconcile_update'
        ? frame.reconciliation
        : undefined,
      { kind: 'updated', previousVersion: '1.0.0', targetVersion: '2.0.0' },
    );
  });

  it('revokes a stale reconcile when automatic policy changes to manual', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-policy-race-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    const deploymentRoot = join(clientDataRoot, 'managed');
    await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, {
      schemaVersion: 1,
      policy: { kind: 'channel', channel: 'latest' },
      target: TARGET,
    });
    let output = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { json: true, framed: false, clientDataRoot, defaultRootPath: '/workspace' },
        {
          manage: async () => managedStatus(deploymentRoot),
          createBackend: () => unusedBackend(),
          resolveSelection: async (options) => {
            await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, null);
            return {
              selector: options.selector,
              candidate: {
                kind: 'npm_registry',
                version: '2.0.0',
                integrity: INTEGRITY,
                compatibility: 1,
              },
              outcome: { kind: 'unattended_update', compatibility: 1 },
              currentCliPath: '/managed/current/cli.js',
              service: SERVICE,
            };
          },
          applySelection: async (_options, _selection, overrides, emit) => {
            const rejection = await overrides?.revalidateSelection?.();
            assert.equal(rejection?.code, 'update_policy_changed');
            emit?.({
              schemaVersion: 1,
              kind: 'error',
              action: 'update',
              error: rejection ?? assert.fail('policy revalidation is required'),
            });
            return 1;
          },
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      1,
    );
    assert.equal(JSON.parse(output).error.code, 'update_policy_changed');
    assert.equal(await readRuntimeHostManagedUpdatePolicy(deploymentRoot), null);
  });

  it('fails closed on corrupt policy and returns manual-action candidates without mutation', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-reconcile-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    const deploymentRoot = join(clientDataRoot, 'managed');
    await mkdir(deploymentRoot, { recursive: true });
    await writeFile(resolveRuntimeHostManagedUpdatePolicyPath(deploymentRoot), '{"bad":true}\n');
    let errorOutput = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { json: true, framed: false, clientDataRoot, defaultRootPath: '/workspace' },
        {
          manage: async () => managedStatus(deploymentRoot),
          createBackend: () => unusedBackend(),
          writeOutput: (value) => {
            errorOutput += value;
          },
        },
      ),
      1,
    );
    assert.equal(JSON.parse(errorOutput).error.code, 'invalid_update_policy');

    await writeRuntimeHostManagedUpdatePolicy(deploymentRoot, {
      schemaVersion: 1,
      policy: { kind: 'channel', channel: 'latest' },
      target: TARGET,
    });
    let output = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { json: true, framed: false, clientDataRoot, defaultRootPath: '/workspace' },
        {
          manage: async () => managedStatus(deploymentRoot),
          createBackend: () => unusedBackend(),
          resolveSelection: async (options) => ({
            selector: options.selector,
            candidate: { kind: 'npm_registry', version: '2.0.0', integrity: INTEGRITY },
            outcome: { kind: 'manual_action', reason: 'target_compatibility_unknown' },
            currentCliPath: '/managed/current/cli.js',
            service: SERVICE,
          }),
          applySelection: async () => assert.fail('update transaction is not expected'),
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      1,
    );
    assert.equal(JSON.parse(output).reconciliation.kind, 'manual_action');
  });
});

function managedStatus(managedDeploymentRoot: string) {
  return {
    schemaVersion: 1 as const,
    action: 'status' as const,
    service: {
      manager: 'systemd_user' as const,
      installed: true,
      enabled: true,
      active: true,
      state: 'running' as const,
      pid: 42,
      lastExitCode: null,
      installedVersion: '1.0.0',
      config: {
        schemaVersion: 1 as const,
        managedDeploymentRoot,
        rootPath: '/srv/maka',
        projectDirectoryRoots: [],
        websocket: { host: '127.0.0.1' as const, port: 7443, path: '/runtime-host' },
        launch: { nodePath: '/node', cliPath: join(managedDeploymentRoot, 'cli.js') },
      },
    },
  };
}

function unusedBackend() {
  return {
    preflightDeployment: async () => undefined,
    stageDeployment: async () => ({
      apply: async () => undefined,
      rollback: async () => undefined,
    }),
    replace: async () => undefined,
    verifyReplacementPreconditions: async () => undefined,
    verifyDeployment: async () => undefined,
    status: async () => ({
      manager: 'systemd_user' as const,
      installed: false,
      enabled: false,
      active: false,
      state: 'not_installed' as const,
      pid: null,
      lastExitCode: null,
    }),
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    retire: async () => undefined,
    logs: async () => '',
    uninstall: async () => undefined,
  };
}
