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
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import {
  assessRuntimeHostUpdate,
  resolveRuntimeHostRegistryUpdateCandidate,
} from '../runtime-host-update-discovery.js';

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
            'dist.integrity': 'sha512-YWJjZA==',
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
    ]);
    assert.deepEqual(candidate, {
      version: '2.0.0-beta.1',
      integrity: 'sha512-YWJjZA==',
      compatibility: 7,
    });

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
    const integrity = 'sha512-YWJjZA==';
    assert.deepEqual(assessRuntimeHostUpdate('1.0.0', undefined, { version: '1.0.0', integrity }), {
      status: 'current',
      unattended: { kind: 'not_needed' },
    });
    assert.deepEqual(
      assessRuntimeHostUpdate('1.0.0-beta.1', 4, {
        version: '1.0.0-beta.2',
        integrity,
        compatibility: 4,
      }),
      { status: 'newer', unattended: { kind: 'allowed', compatibility: 4 } },
    );
    assert.deepEqual(assessRuntimeHostUpdate('1.0.0', 4, { version: '2.0.0', integrity }), {
      status: 'newer',
      unattended: { kind: 'manual_only', reason: 'target_compatibility_unknown' },
    });
    assert.deepEqual(
      assessRuntimeHostUpdate('1.0.0', 4, {
        version: '0.9.0',
        integrity,
        compatibility: 4,
      }),
      {
        status: 'older',
        unattended: { kind: 'manual_only', reason: 'target_not_newer' },
      },
    );
  });
});
