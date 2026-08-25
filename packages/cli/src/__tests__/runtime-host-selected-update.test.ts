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
import type { RuntimeHostUpdateSelection } from '../runtime-host-update-discovery.js';

const INTEGRITY =
  'sha512-jUKdo/5dbM94KXq+kOZ1d+obhDLAENfI/QWr1PnXWcdu2PqDyLklJBtiVO6HRwoL1l40z1NE9Rq+hLAxCN0Fyg==';
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

  it('keeps non-admitted candidates outside package acquisition and mutation', async () => {
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
