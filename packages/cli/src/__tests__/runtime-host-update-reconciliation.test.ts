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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  decodeRuntimeHostServiceManagementFrame,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { runManagedRuntimeHostServiceCli } from '../runtime-host-service-management-command.js';
import {
  runManagedRuntimeHostUpdatePolicyCli,
  runManagedRuntimeHostUpdateReconcileCli,
} from '../runtime-host-update-reconciliation.js';
import {
  readRuntimeHostManagedUpdatePolicy,
  resolveRuntimeHostManagedUpdatePolicyPath,
  writeRuntimeHostManagedUpdatePolicy,
} from '../runtime-host-update-policy-store.js';

const INTEGRITY =
  'sha512-jUKdo/5dbM94KXq+kOZ1d+obhDLAENfI/QWr1PnXWcdu2PqDyLklJBtiVO6HRwoL1l40z1NE9Rq+hLAxCN0Fyg==';
const TARGET = {
  serviceId: 'b'.repeat(64),
  rootPath: '/srv/maka-link',
  rootId: 'a'.repeat(64),
};
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
  it('parses one mutually exclusive policy and a target-free reconcile command', () => {
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
      ]),
      {
        kind: 'runtime-host-service-update-policy',
        json: false,
        policy: { kind: 'channel', channel: 'next' },
        expectedTarget: TARGET,
      },
    );
    assert.deepEqual(parseRuntimeHostCommand(['service', 'reconcile-update', '--json']), {
      kind: 'runtime-host-service-reconcile-update',
      json: true,
    });
    assert.equal(
      parseRuntimeHostCommand(['service', 'update-policy', '--target', 'latest']).kind,
      'error',
    );
  });

  it('persists an automatic policy against the canonical managed target and removes manual state', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-policy-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    const common = {
      json: true,
      framed: false,
      clientDataRoot,
      defaultRootPath: '/workspace',
    };
    let output = '';
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
          manage: async () => ({
            schemaVersion: 1,
            action: 'status',
            service: {
              manager: 'systemd_user',
              installed: true,
              enabled: true,
              active: true,
              state: 'running',
              pid: 42,
              lastExitCode: null,
              installedVersion: '1.0.0',
              config: {
                schemaVersion: 1,
                managedDeploymentRoot: '/managed',
                rootPath: '/srv/maka',
                projectDirectoryRoots: [],
                websocket: { host: '127.0.0.1', port: 7443, path: '/runtime-host' },
                launch: { nodePath: '/node', cliPath: '/managed/cli.js' },
              },
            },
          }),
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      0,
    );
    assert.deepEqual(await readRuntimeHostManagedUpdatePolicy(clientDataRoot), {
      schemaVersion: 1,
      policy: { kind: 'fixed', version: '2.0.0' },
      target: { ...TARGET, rootPath: '/srv/maka' },
    });
    assert.equal(JSON.parse(output).updatePolicy.policy.kind, 'fixed');

    assert.equal(
      await runManagedRuntimeHostUpdatePolicyCli(
        { ...common, policy: { kind: 'manual' } },
        {
          withDeploymentLock: async (_root, operation) => operation(),
          writeOutput: () => undefined,
        },
      ),
      0,
    );
    assert.equal(await readRuntimeHostManagedUpdatePolicy(clientDataRoot), null);
    let manualOutput = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { ...common, json: false, framed: true },
        {
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
  });

  it('resolves one policy snapshot and delegates an admitted exact target to the update transaction', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-reconcile-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    await writeRuntimeHostManagedUpdatePolicy(clientDataRoot, {
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
        resolveSelection: async (options) => {
          assert.deepEqual(options.selector, { kind: 'exact', version: '2.0.0' });
          assert.deepEqual(options.expectedTarget, TARGET);
          return {
            selector: options.selector,
            candidate: { version: '2.0.0', integrity: INTEGRITY, compatibility: 1 },
            outcome: { kind: 'unattended_update', compatibility: 1 },
            currentCliPath: '/managed/current/cli.js',
            service: SERVICE,
          };
        },
        applySelection: async (_options, _selection, _overrides, emit) => {
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

  it('fails closed on corrupt policy and returns manual-action candidates without mutation', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-reconcile-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    await writeFile(resolveRuntimeHostManagedUpdatePolicyPath(clientDataRoot), '{"bad":true}\n');
    let errorOutput = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { json: true, framed: false, clientDataRoot, defaultRootPath: '/workspace' },
        {
          writeOutput: (value) => {
            errorOutput += value;
          },
        },
      ),
      1,
    );
    assert.equal(JSON.parse(errorOutput).error.code, 'invalid_update_policy');

    await writeRuntimeHostManagedUpdatePolicy(clientDataRoot, {
      schemaVersion: 1,
      policy: { kind: 'channel', channel: 'latest' },
      target: TARGET,
    });
    let output = '';
    assert.equal(
      await runManagedRuntimeHostUpdateReconcileCli(
        { json: true, framed: false, clientDataRoot, defaultRootPath: '/workspace' },
        {
          resolveSelection: async (options) => ({
            selector: options.selector,
            candidate: { version: '2.0.0', integrity: INTEGRITY },
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

  it('keeps automatic policy revoked when uninstall later fails', async (t) => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-update-uninstall-'));
    t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
    await writeRuntimeHostManagedUpdatePolicy(clientDataRoot, {
      schemaVersion: 1,
      policy: { kind: 'channel', channel: 'next' },
      target: TARGET,
    });
    const immediate = async <T>(_root: string, operation: () => Promise<T>) => operation();
    assert.equal(
      await runManagedRuntimeHostServiceCli(
        {
          action: 'uninstall',
          json: false,
          clientDataRoot,
          defaultRootPath: '/workspace',
          nodePath: '/node',
          cliPath: '/cli.js',
        },
        {
          withDeploymentLock: immediate,
          withLifecycleLock: immediate,
          createBackend: () => unusedBackend(),
          manage: async () => {
            assert.equal(await readRuntimeHostManagedUpdatePolicy(clientDataRoot), null);
            throw new Error('uninstall failed after policy revocation');
          },
          writeError: () => undefined,
        },
      ),
      1,
    );
    assert.equal(await readRuntimeHostManagedUpdatePolicy(clientDataRoot), null);
  });
});

function unusedBackend() {
  return {
    preflightInstall: async () => undefined,
    install: async () => ({ rollback: async () => undefined }),
    replace: async () => undefined,
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
    logs: async () => '',
    uninstall: async () => undefined,
  };
}
