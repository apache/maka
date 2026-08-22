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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectRuntimeHostFailureDiagnostic,
  retireCollectedRuntimeHostStartupDiagnostic,
} from './release-cli-runtime-host-diagnostics.mjs';

const ROOT_ID = 'a'.repeat(64);
const STARTUP_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';

test('collects canonical Runtime Host evidence without invoking mutating storage authority', async () => {
  const fixture = createFixture();
  try {
    const startupDiagnostic = {
      schemaVersion: 1,
      rootId: ROOT_ID,
      startupAttemptId: STARTUP_ATTEMPT_ID,
      candidatePid: 123,
      capturedAt: '2026-08-19T00:00:00.000Z',
      reason: 'local_ipc_security_failed',
      errorChain: [{ message: '{"stage":"acl_apply"}' }],
      logs: ['endpoint setup failed'],
    };
    const securityCalls = [];
    const diagnostic = await collectRuntimeHostFailureDiagnostic('/installed', fixture.root, {
      platform: 'win32',
      architecture: 'x64',
      environment: {
        ImageOS: 'win25',
        ImageVersion: '20260817.1',
        RUNNER_NAME: 'hosted-runner',
        RUNNER_ENVIRONMENT: 'github-hosted',
      },
      loadInstalled: async (_packageRoot, relativePath) => {
        if (relativePath.endsWith('/root-authority.js')) {
          return {
            STORAGE_ROOT_MARKER_FILE: '.maka-storage-root.json',
            discoverMarkedStorageRoot: async () => ({ rootId: ROOT_ID }),
            resolveRootControlNamespace: () => fixture.controlRoot,
          };
        }
        if (relativePath.endsWith('/registration.js')) {
          return {
            RUNTIME_HOST_REGISTRATION_FILE: 'registration.json',
            readHostRegistration: async () => ({
              schemaVersion: 1,
              rootId: ROOT_ID,
              hostEpoch: 'host-epoch',
              state: 'recovering',
              lifecycleMode: 'interactive',
              pid: 123,
              endpoint: '\\\\.\\pipe\\maka-runtime-host',
            }),
          };
        }
        if (relativePath.endsWith('/startup-diagnostic.js')) {
          return {
            RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE: 'startup-diagnostic.json',
            readCandidateStartupDiagnostic: async () => startupDiagnostic,
          };
        }
        throw new Error(`Unexpected installed module: ${relativePath}`);
      },
      readPathSecurityBatch: async (paths) => {
        securityCalls.push(paths);
        return paths.map(() => ({
          state: 'present',
          owner: 'runner\\user',
          sddl: 'O:SYD:P',
        }));
      },
    });

    assert.deepEqual(
      diagnostic.paths.map(({ role }) => role),
      [
        'root',
        'root_marker',
        'control_root',
        'control_directory',
        'registration',
        'startup_diagnostic',
      ],
    );
    assert.deepEqual(securityCalls, [
      [fixture.root, fixture.controlRoot, fixture.controlDirectory],
    ]);
    assert.equal(diagnostic.paths[0].security.owner, 'runner\\user');
    assert.equal(diagnostic.storageAuthority.state, 'valid');
    assert.equal(diagnostic.registration.rootIdMatches, true);
    assert.deepEqual(diagnostic.startup, { state: 'present', diagnostic: startupDiagnostic });
    assert.equal(diagnostic.runner.architecture, undefined);

    let retired;
    assert.equal(
      await retireCollectedRuntimeHostStartupDiagnostic('/installed', diagnostic, {
        loadInstalled: async (_packageRoot, relativePath) => {
          assert.match(relativePath, /startup-diagnostic\.js$/u);
          return {
            clearSelectedCandidateStartupDiagnostic: async (rootId, startupAttemptId) => {
              retired = { rootId, startupAttemptId };
              return true;
            },
          };
        },
      }),
      true,
    );
    assert.deepEqual(retired, { rootId: ROOT_ID, startupAttemptId: STARTUP_ATTEMPT_ID });
  } finally {
    fixture.cleanup();
  }
});

test('keeps read-only path evidence when root authority validation fails', async () => {
  const fixture = createFixture({ createControlDirectory: false });
  try {
    const diagnostic = await collectRuntimeHostFailureDiagnostic('/installed', fixture.root, {
      platform: 'win32',
      loadInstalled: async (_packageRoot, relativePath) => {
        if (!relativePath.endsWith('/root-authority.js')) {
          throw new Error(`Unexpected installed module: ${relativePath}`);
        }
        return {
          STORAGE_ROOT_MARKER_FILE: '.maka-storage-root.json',
          discoverMarkedStorageRoot: async () => {
            throw new Error('marker validation failed', {
              cause: Object.assign(new Error('Access is denied'), { code: 'EACCES' }),
            });
          },
          resolveRootControlNamespace: () => fixture.controlRoot,
        };
      },
      readPathSecurityBatch: async (paths) => {
        return paths.map((path) =>
          path === fixture.root
            ? {
                state: 'unavailable',
                error: { name: 'UnauthorizedAccessException', nativeErrorCode: 5 },
              }
            : { state: 'present', owner: 'runner\\user', sddl: 'O:SYD:P' },
        );
      },
    });

    assert.equal(diagnostic.storageAuthority.state, 'invalid');
    assert.equal(diagnostic.storageAuthority.error.cause.code, 'EACCES');
    assert.equal(diagnostic.paths[0].security.state, 'unavailable');
    assert.equal(diagnostic.paths[0].security.error.nativeErrorCode, 5);
    assert.deepEqual(
      diagnostic.paths.map(({ role }) => role),
      ['root', 'root_marker', 'control_root'],
    );
    assert.equal(existsSync(fixture.controlDirectory), false);
  } finally {
    fixture.cleanup();
  }
});

function createFixture({ createControlDirectory = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maka-runtime-host-diagnostic-test-'));
  const root = join(base, 'root');
  const controlRoot = join(base, 'control');
  const controlDirectory = join(controlRoot, ROOT_ID);
  const registrationPath = join(controlDirectory, 'registration.json');
  const startupPath = join(controlDirectory, 'startup-diagnostic.json');
  mkdirSync(root, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  writeFileSync(join(root, '.maka-storage-root.json'), '{}\n');
  if (createControlDirectory) {
    mkdirSync(controlDirectory, { recursive: true });
    writeFileSync(registrationPath, '{}\n');
    writeFileSync(startupPath, '{}\n');
  }
  return {
    root,
    controlRoot,
    controlDirectory,
    registrationPath,
    startupPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
