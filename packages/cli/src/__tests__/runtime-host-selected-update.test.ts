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
  runManagedRuntimeHostSelectedUpdateCli,
  type RuntimeHostSelectedUpdateCliOptions,
  type RuntimeHostUpdateCliOptions,
} from '../runtime-host-update-command.js';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import type { RuntimeHostUpdateCheckResolution } from '../runtime-host-update-discovery.js';

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
    const resolution = updateResolution({ kind: 'unattended_update', compatibility: 7 });
    let cleanupCalls = 0;
    let updateInput: RuntimeHostUpdateCliOptions | undefined;
    const exitCode = await runManagedRuntimeHostSelectedUpdateCli(OPTIONS, {
      resolveCheck: async () => resolution,
      acquire: async (candidate) => {
        assert.deepEqual(candidate, resolution.candidate);
        return {
          root: '/verified/package',
          cleanup: async () => {
            cleanupCalls += 1;
          },
        };
      },
      update: async (input) => {
        updateInput = input;
        return 0;
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(updateInput?.sourcePackageRoot, '/verified/package');
    assert.equal(updateInput?.version, '2.0.0');
    assert.equal(updateInput?.expectedCurrentVersion, '1.0.0');
    assert.equal(cleanupCalls, 1);
  });

  it('keeps current and non-admitted candidates outside the mutation path', async () => {
    for (const outcome of [
      { kind: 'current' as const },
      { kind: 'manual_action' as const, reason: 'compatibility_mismatch' as const },
    ]) {
      let output = '';
      const exitCode = await runManagedRuntimeHostSelectedUpdateCli(OPTIONS, {
        resolveCheck: async () => updateResolution(outcome),
        acquire: async () => assert.fail('package acquisition is not expected'),
        update: async () => assert.fail('the update transaction is not expected'),
        writeOutput: (value) => {
          output += value;
        },
      });
      const frame = decodeRuntimeHostServiceManagementFrame(output.trim());
      if (outcome.kind === 'current') {
        assert.equal(exitCode, 0);
        assert.equal(
          frame?.kind === 'result' && frame.action === 'update' ? frame.update.kind : undefined,
          'already_current',
        );
      } else {
        assert.equal(exitCode, 1);
        assert.equal(frame?.kind === 'error' ? frame.error.code : undefined, 'update_not_admitted');
      }
    }
  });
});

function updateResolution(
  outcome: RuntimeHostUpdateCheckResolution['frame']['updateCheck']['outcome'],
): RuntimeHostUpdateCheckResolution {
  const candidate = { version: '2.0.0', integrity: INTEGRITY, compatibility: 7 };
  return {
    candidate,
    frame: {
      schemaVersion: 1,
      kind: 'result',
      action: 'check_update',
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
      updateCheck: {
        selector: OPTIONS.selector,
        candidate: { version: candidate.version, integrity: candidate.integrity },
        outcome,
      },
    },
  };
}
