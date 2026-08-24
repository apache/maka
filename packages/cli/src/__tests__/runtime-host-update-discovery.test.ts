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
import {
  encodeRuntimeHostServiceManagementFrame,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import {
  assessRuntimeHostUpdate,
  formatRuntimeHostUpdateCheck,
  resolveRuntimeHostRegistryUpdateCandidate,
} from '../runtime-host-update-discovery.js';

const INTEGRITY =
  'sha512-jUKdo/5dbM94KXq+kOZ1d+obhDLAENfI/QWr1PnXWcdu2PqDyLklJBtiVO6HRwoL1l40z1NE9Rq+hLAxCN0Fyg==';
const FRAME = {
  schemaVersion: 1,
  kind: 'result',
  action: 'check_update',
  service: {
    platform: 'darwin',
    arch: 'arm64',
    osRelease: 'test',
    state: 'stopped',
    pid: null,
    lastExitCode: 0,
    installedVersion: '1.0.0',
    projectDirectoryRoots: [],
  },
  updateCheck: {
    selector: { kind: 'exact', version: '2.0.0' },
    candidate: { version: '2.0.0', integrity: INTEGRITY },
    outcome: { kind: 'unattended_update', compatibility: 4 },
  },
} as const satisfies RuntimeHostServiceManagementFrame;

describe('managed Runtime Host update discovery', () => {
  it('accepts only channels or canonical exact versions', () => {
    assert.deepEqual(
      parseRuntimeHostCommand(['service', 'check-update', '--target', 'latest', '--json']),
      {
        kind: 'runtime-host-service-check-update',
        json: true,
        selector: { kind: 'channel', channel: 'latest' },
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand(['service', 'check-update', '--target', '1.2.3-beta.4']),
      {
        kind: 'runtime-host-service-check-update',
        json: false,
        selector: { kind: 'exact', version: '1.2.3-beta.4' },
      },
    );
    for (const target of ['1.2', '01.2.3', '1.2.3-beta.01', '../latest']) {
      assert.equal(
        parseRuntimeHostCommand(['service', 'check-update', '--target', target]).kind,
        'error',
      );
    }
  });

  it('pins registry metadata to an exact version and integrity', async () => {
    let observedArgs: readonly string[] = [];
    const candidate = await resolveRuntimeHostRegistryUpdateCandidate(
      { kind: 'channel', channel: 'next' },
      async (args) => {
        observedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: '2.0.0-beta.1',
            'dist.integrity': INTEGRITY,
            'maka.managedRuntimeHostUpdateCompatibility': 7,
          }),
        };
      },
    );
    assert.deepEqual(observedArgs, [
      'view',
      'maka-agent@next',
      'version',
      'dist.integrity',
      'maka.managedRuntimeHostUpdateCompatibility',
      '--json',
      '--registry',
      'https://registry.npmjs.org/',
    ]);
    assert.deepEqual(candidate, {
      version: '2.0.0-beta.1',
      integrity: INTEGRITY,
      compatibility: 7,
    });

    await assert.rejects(
      resolveRuntimeHostRegistryUpdateCandidate({ kind: 'channel', channel: 'next' }, async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          version: '2.0.0',
          'dist.integrity': 'sha512-YWJjZA==',
        }),
      })),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'invalid_registry_metadata',
    );
    await assert.rejects(
      resolveRuntimeHostRegistryUpdateCandidate({ kind: 'exact', version: '9.0.0' }, async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ error: { code: 'E404' } }),
      })),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'target_unavailable',
    );
    await assert.rejects(
      resolveRuntimeHostRegistryUpdateCandidate(
        { kind: 'channel', channel: 'latest' },
        async () => ({ exitCode: 1, stdout: '' }),
      ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'registry_unavailable',
    );
  });

  it('admits only newer packages with matching compatibility evidence', () => {
    assert.deepEqual(
      assessRuntimeHostUpdate('1.0.0', undefined, { version: '1.0.0', integrity: INTEGRITY }),
      { kind: 'current' },
    );
    assert.deepEqual(
      assessRuntimeHostUpdate('1.0.0-beta.1', 4, {
        version: '1.0.0-beta.2',
        integrity: INTEGRITY,
        compatibility: 4,
      }),
      { kind: 'unattended_update', compatibility: 4 },
    );
    const manual = assessRuntimeHostUpdate('1.0.0', 4, {
      version: '2.0.0',
      integrity: INTEGRITY,
    });
    assert.deepEqual(manual, { kind: 'manual_action', reason: 'target_compatibility_unknown' });
    assert.deepEqual(
      assessRuntimeHostUpdate('1.0.0', 4, {
        version: '0.9.0',
        integrity: INTEGRITY,
        compatibility: 4,
      }),
      { kind: 'manual_action', reason: 'target_not_newer' },
    );
    assert.deepEqual(
      assessRuntimeHostUpdate('1.0.0', 4, {
        version: '2.0.0',
        integrity: INTEGRITY,
        compatibility: 5,
      }),
      { kind: 'manual_action', reason: 'compatibility_mismatch' },
    );
    assert.match(
      formatRuntimeHostUpdateCheck({
        ...FRAME,
        updateCheck: { ...FRAME.updateCheck, outcome: manual },
      }),
      /target package has no unattended-update compatibility evidence/u,
    );
  });

  it('rejects malformed or contradictory machine evidence', () => {
    assert.doesNotThrow(() => encodeRuntimeHostServiceManagementFrame(FRAME));
    assert.throws(() =>
      encodeRuntimeHostServiceManagementFrame({
        ...FRAME,
        updateCheck: {
          ...FRAME.updateCheck,
          candidate: { version: '9.0.0', integrity: INTEGRITY },
        },
      }),
    );
    assert.throws(() =>
      encodeRuntimeHostServiceManagementFrame({
        ...FRAME,
        updateCheck: {
          ...FRAME.updateCheck,
          candidate: { version: '2.0.0', integrity: 'not-a-digest' },
        },
      }),
    );
    assert.throws(() =>
      encodeRuntimeHostServiceManagementFrame({
        ...FRAME,
        updateCheck: {
          ...FRAME.updateCheck,
          outcome: { kind: 'current' },
        },
      }),
    );
    assert.throws(() =>
      encodeRuntimeHostServiceManagementFrame({
        ...FRAME,
        service: { ...FRAME.service, installedVersion: 'not-a-version' },
      }),
    );
  });
});
