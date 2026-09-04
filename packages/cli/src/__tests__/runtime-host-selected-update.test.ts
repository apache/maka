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
import { describe, it } from 'node:test';
import { decodeRuntimeHostServiceManagementFrame } from '@maka/runtime-host/operator';
import {
  runManagedRuntimeHostUpdateCli,
  runManagedRuntimeHostSelectedUpdateCli,
  type RuntimeHostSelectedUpdateCliOptions,
  type RuntimeHostUpdateCliOptions,
} from '../runtime-host-update-command.js';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { RuntimeHostLifecycleTransactionError } from '../runtime-host-lifecycle-transaction.js';
import type { RuntimeHostUpdateSelection } from '../runtime-host-update-discovery.js';

const INTEGRITY =
  'sha512-jUKdo/5dbM94KXq+kOZ1d+obhDLAENfI/QWr1PnXWcdu2PqDyLklJBtiVO6HRwoL1l40z1NE9Rq+hLAxCN0Fyg==';
const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';
const TARGET = {
  serviceId: 'b'.repeat(64),
  rootPath: '/srv/maka',
  rootId: 'a'.repeat(64),
};
const OPTIONS: RuntimeHostSelectedUpdateCliOptions = {
  json: false,
  framed: true,
  clientDataRoot: '/client',
  defaultRootPath: '/workspace',
  selector: { kind: 'channel', channel: 'next' },
  expectedTarget: TARGET,
};

describe('managed Runtime Host selected update', () => {
  it('replaces an exact observed Host even when its package is already current', async () => {
    const current = {
      configRevision: 7,
      deploymentRoot: '/managed',
      root: { id: TARGET.rootId, path: TARGET.rootPath },
      lifecycle: { mode: 'supervised', provider: 'test' },
      launch: {
        package: { kind: 'npm_registry', version: '2.0.0', integrity: INTEGRITY },
      },
    };
    const status = {
      schemaVersion: 1,
      action: 'status',
      service: {
        manager: 'systemd_user',
        installed: true,
        enabled: true,
        active: true,
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '2.0.0',
        config: {
          schemaVersion: 1,
          managedDeploymentRoot: '/managed',
          rootPath: TARGET.rootPath,
          projectDirectoryRoots: [],
          websocket: { host: '127.0.0.1', port: 7400, path: '/runtime-host' },
          launch: { nodePath: process.execPath, cliPath: '/managed/current/dist/cli.js' },
        },
      },
    };
    const expectedHost = { hostEpoch: 'older-host', pid: 42 };
    let output = '';
    let managedReads = 0;
    let pruned = false;
    const exitCode = await runManagedRuntimeHostUpdateCli(
      {
        ...OPTIONS,
        sourcePackageRoot: '/managed/current',
        version: '2.0.0',
        managedRootId: TARGET.rootId,
        expectedHost,
      },
      {
        withDeploymentLock: async (_root, operation) => operation(),
        prepareDeployment: async () => assert.fail('current package must not be staged'),
        prunePackages: async (config) => {
          assert.equal(config.configRevision, 8);
          pruned = true;
        },
        canonical: {
          createLifecycleDeps: () => ({}) as never,
          assertOperatorDeployment: async () => {},
          recoverDeployment: async (_rootId, _deps, options) => {
            assert.deepEqual(options?.expectedOwner, expectedHost);
            return { kind: 'active', config: current } as never;
          },
          verifyProjection: async () => {},
          assertOperatorConfig: () => {},
          manageLifecycle: async () => {
            managedReads += 1;
            if (managedReads === 2) assert.equal(pruned, false);
            return status as never;
          },
          replaceLifecycle: async (input) => {
            assert.equal(input.current, current);
            assert.deepEqual(input.expectedOwner, expectedHost);
            assert.equal(input.allowInterruptActiveTasks, false);
            assert.equal(input.desired.configRevision, 8);
            return { kind: 'replaced', config: input.desired };
          },
        },
        writeOutput: (value) => {
          output += value;
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(managedReads, 2);
    assert.equal(pruned, true);
    assert.doesNotMatch(output, /"phase":"staging"/u);
    const result = decodeRuntimeHostServiceManagementFrame(output.trim().split('\n').at(-1) ?? '');
    assert.equal(
      result?.kind === 'result' && result.action === 'update' ? result.update.kind : undefined,
      'repaired',
    );
  });

  it('revalidates selection inside the deployment lock before reading service state', async () => {
    let lockHeld = false;
    let output = '';
    assert.equal(
      await runManagedRuntimeHostUpdateCli(
        {
          ...OPTIONS,
          sourcePackageRoot: '/verified/package',
          version: '2.0.0',
        },
        {
          withDeploymentLock: async (_root, operation) => {
            lockHeld = true;
            try {
              return await operation();
            } finally {
              lockHeld = false;
            }
          },
          revalidateSelection: async () => {
            assert.equal(lockHeld, true);
            return { code: 'update_policy_changed', message: 'The policy changed' };
          },
          manage: async () => assert.fail('service state must not be read'),
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      1,
    );
    const frame = decodeRuntimeHostServiceManagementFrame(output.trim());
    assert.equal(frame?.kind === 'error' ? frame.error.code : undefined, 'update_policy_changed');
  });

  it('parses an optional target without changing the exact-package command', () => {
    assert.deepEqual(
      parseRuntimeHostCommand([
        'service',
        'update',
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
        kind: 'runtime-host-service-update',
        json: false,
        selector: { kind: 'channel', channel: 'next' },
        expectedTarget: TARGET,
      },
    );
    assert.equal(
      'selector' in
        parseRuntimeHostCommand([
          'service',
          'update',
          '--expected-service-id',
          TARGET.serviceId,
          '--expected-root-path',
          TARGET.rootPath,
          '--expected-root-id',
          TARGET.rootId,
        ]),
      false,
    );
  });

  it('requires exact canonical deployment authority for manual update consent', () => {
    const args = [
      'service',
      'update',
      '--target',
      '2.0.0',
      '--allow-manual-update',
      '--managed-root-id',
      TARGET.rootId,
      '--expected-service-id',
      TARGET.serviceId,
      '--expected-root-path',
      TARGET.rootPath,
      '--expected-root-id',
      TARGET.rootId,
      '--expected-deployment-id',
      DEPLOYMENT_ID,
    ];
    assert.deepEqual(parseRuntimeHostCommand(args), {
      kind: 'runtime-host-service-update',
      json: false,
      managedRootId: TARGET.rootId,
      selector: { kind: 'exact', version: '2.0.0' },
      expectedTarget: { ...TARGET, deploymentId: DEPLOYMENT_ID },
      allowManualUpdate: true,
    });
  });

  it('carries interruption authority through selection and preserves active work', async () => {
    let output = '';
    const exitCode = await runManagedRuntimeHostSelectedUpdateCli(
      { ...OPTIONS, allowInterruptActiveTasks: true },
      {
        resolveSelection: async (options) => {
          assert.equal(options.allowInterruptActiveTasks, true);
          throw new RuntimeHostLifecycleTransactionError('active_tasks', 'active work');
        },
        writeOutput(value) {
          output += value;
        },
      },
    );
    const frame = decodeRuntimeHostServiceManagementFrame(output.trim());
    assert.equal(exitCode, 1);
    assert.equal(frame?.kind === 'error' ? frame.error.code : undefined, 'active_tasks');
  });

  it('hands one verified admitted package to the existing update transaction', async () => {
    const selection = updateSelection({
      kind: 'unattended_update',
      compatibility: 7,
    });
    let updateInput: RuntimeHostUpdateCliOptions | undefined;
    const exitCode = await runManagedRuntimeHostSelectedUpdateCli(OPTIONS, {
      resolveSelection: async () => selection,
      withPackage: async (candidate, use) => {
        assert.deepEqual(candidate, selection.candidate);
        return use('/verified/package');
      },
      update: async (input) => {
        updateInput = input;
        return 0;
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(updateInput?.sourcePackageRoot, '/verified/package');
    assert.equal(updateInput?.version, '2.0.0');
    assert.deepEqual(updateInput?.registrySelection, {
      integrity: INTEGRITY,
      current: {
        version: '1.0.0',
        cliPath: '/managed/versions/1.0.0/dist/cli.js',
      },
    });
  });

  it('lets the exact transaction inspect the current deployment without downloading it again', async () => {
    const selection = updateSelection({ kind: 'current' });
    let updateInput: RuntimeHostUpdateCliOptions | undefined;
    assert.equal(
      await runManagedRuntimeHostSelectedUpdateCli(OPTIONS, {
        resolveSelection: async () => selection,
        withPackage: async () => assert.fail('the current deployment must not be downloaded'),
        update: async (input) => {
          updateInput = input;
          return 0;
        },
      }),
      0,
    );
    assert.equal(updateInput?.sourcePackageRoot, '/managed/versions/2.0.0');
  });

  it('requires a registration-bound confirmation for manual candidates', async () => {
    let output = '';
    const exitCode = await runManagedRuntimeHostSelectedUpdateCli(OPTIONS, {
      resolveSelection: async () =>
        updateSelection({
          kind: 'manual_action',
          reason: 'compatibility_mismatch',
        }),
      withPackage: async () => assert.fail('package acquisition is not expected'),
      update: async () => assert.fail('the update transaction is not expected'),
      writeOutput: (value) => {
        output += value;
      },
    });
    const frame = decodeRuntimeHostServiceManagementFrame(output.trim());
    assert.equal(exitCode, 1);
    assert.equal(frame?.kind === 'error' ? frame.error.code : undefined, 'update_not_admitted');

    const selection = updateSelection({
      kind: 'manual_action',
      reason: 'compatibility_mismatch',
    });
    let updateInput: RuntimeHostUpdateCliOptions | undefined;
    assert.equal(
      await runManagedRuntimeHostSelectedUpdateCli(
        {
          ...OPTIONS,
          expectedHost: { hostEpoch: 'older-host', pid: 42 },
          allowInterruptActiveTasks: true,
        },
        {
          resolveSelection: async () => selection,
          withPackage: async (_candidate, use) => use('/verified/package'),
          update: async (input) => {
            updateInput = input;
            return 0;
          },
        },
      ),
      0,
    );
    assert.deepEqual(updateInput?.expectedHost, { hostEpoch: 'older-host', pid: 42 });

    const safeUpdates: RuntimeHostUpdateCliOptions[] = [];
    assert.equal(
      await runManagedRuntimeHostSelectedUpdateCli(
        {
          ...OPTIONS,
          expectedHost: { hostEpoch: 'older-host', pid: 42 },
        },
        {
          resolveSelection: async () => selection,
          withPackage: async (_candidate, use) => use('/verified/package'),
          update: async (input) => {
            safeUpdates.push(input);
            return 0;
          },
        },
      ),
      0,
    );
    assert.deepEqual(safeUpdates[0]?.expectedHost, { hostEpoch: 'older-host', pid: 42 });
    assert.equal(safeUpdates[0]?.allowInterruptActiveTasks, undefined);

    const legacySelection = updateSelection({
      kind: 'manual_action',
      reason: 'current_compatibility_unknown',
    });
    const recoveryUpdates: RuntimeHostUpdateCliOptions[] = [];
    assert.equal(
      await runManagedRuntimeHostSelectedUpdateCli(
        {
          ...OPTIONS,
          managedRootId: TARGET.rootId,
          expectedTarget: { ...TARGET, deploymentId: DEPLOYMENT_ID },
          allowManualUpdate: true,
        },
        {
          resolveSelection: async () => legacySelection,
          withPackage: async (_candidate, use) => use('/verified/package'),
          update: async (input) => {
            recoveryUpdates.push(input);
            return 0;
          },
        },
      ),
      0,
    );
    assert.equal(recoveryUpdates[0]?.expectedHost, undefined);
    assert.equal(recoveryUpdates[0]?.allowInterruptActiveTasks, undefined);
  });
});

function updateSelection(
  outcome: RuntimeHostUpdateSelection['outcome'],
): RuntimeHostUpdateSelection {
  const candidate = {
    kind: 'npm_registry' as const,
    version: '2.0.0',
    integrity: INTEGRITY,
    compatibility: 7,
  };
  return {
    selector: OPTIONS.selector,
    candidate,
    outcome,
    currentCliPath: `/managed/versions/${outcome.kind === 'current' ? candidate.version : '1.0.0'}/dist/cli.js`,
    service: {
      platform: 'linux',
      arch: 'x64',
      osRelease: 'test',
      state: 'running',
      pid: 42,
      lastExitCode: null,
      installedVersion: outcome.kind === 'current' ? candidate.version : '1.0.0',
      stateRoot: TARGET.rootPath,
      projectDirectoryRoots: [],
    },
  };
}
