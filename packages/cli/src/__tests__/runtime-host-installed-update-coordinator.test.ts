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
import test from 'node:test';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import { runRuntimeHostInstalledUpdateCoordinator } from '../runtime-host-installed-update-coordinator.js';
import type { RuntimeHostLocalProcessLifecycleAdapter } from '../runtime-host-local-handoff.js';

const ROOT_ID = 'b'.repeat(64);
const INTEGRITY = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;
const OWNER = { kind: 'cli' as const, installationId: 'npm-global:slot' };

test('retires with the current package, activates with the target, then switches npm before commit', async () => {
  const events: string[] = [];
  let installationRead = 0;
  let hostObservation = 0;
  const oldInstallation = {
    owner: OWNER,
    observedRelease: {
      version: '1.0.0',
      packageRoot: '/global/node_modules/maka-agent',
      cliPath: '/global/node_modules/maka-agent/dist/cli.js',
    },
  };
  const target = { kind: 'npm_registry' as const, version: '2.0.0', integrity: INTEGRITY };

  const exitCode = await runRuntimeHostInstalledUpdateCoordinator(
    {
      rootPath: '/state',
      archivePath: '/temporary/target.tgz',
      installedPackageRoot: oldInstallation.observedRelease.packageRoot,
      installedCliPath: oldInstallation.observedRelease.cliPath,
      currentVersion: oldInstallation.observedRelease.version,
      target,
      allowInterruptActiveTasks: true,
    },
    {},
    {
      resolveInstallation: async () => {
        installationRead += 1;
        events.push(
          installationRead === 1 ? 'observe-old-installation' : 'verify-new-installation',
        );
        return installationRead === 1
          ? oldInstallation
          : {
              owner: OWNER,
              observedRelease: { ...oldInstallation.observedRelease, version: target.version },
            };
      },
      resolveRoot: async () =>
        ({ kind: 'interactive', canonicalPath: '/state', rootId: ROOT_ID }) as never,
      withArchive: async (_target, archivePath, use) => {
        assert.equal(archivePath, '/temporary/target.tgz');
        return use({ archivePath, packageRoot: '/temporary/target-package' });
      },
      prepareStaged: async (input) => {
        events.push('stage-target');
        assert.equal(input.sourcePackageRoot, '/temporary/target-package');
        return {
          version: target.version,
          root: '/store',
          packageRoot: '/store/target',
          cliPath: '/store/target/dist/cli.js',
          candidateEntrypoint: '/store/target/runtime-host.js',
          launchGeneration: 'target-generation',
          cleanup: async () => {},
          rollback: async () => {},
        };
      },
      connectExisting: async () => {
        hostObservation += 1;
        return {
          kind: 'connected',
          registration: registration(),
          connection: {
            close: async () =>
              events.push(hostObservation === 1 ? 'close-preliminary' : 'close-old-host'),
          } as never,
        };
      },
      prepareRetirement: async (_connection, mode) => {
        events.push(`retire:${mode}`);
        return { kind: 'prepared', pid: 42 };
      },
      activateTarget: async (input) => {
        events.push('activate-target');
        assert.equal(input.takeoverHostEpoch, 'old-host');
        assert.equal(input.inheritableAuthorityLeaseFd, 17);
        return 'ready';
      },
      installArchive: async (archivePath, inheritableAuthorityLeaseFd) => {
        assert.equal(archivePath, '/temporary/target.tgz');
        assert.equal(inheritableAuthorityLeaseFd, 17);
        events.push('switch-global-package');
      },
      reconcile: (async (_request: unknown, lifecycle: RuntimeHostLocalProcessLifecycleAdapter) => {
        assert.deepEqual(
          await lifecycle.prepareHostCutover(
            ROOT_ID,
            target,
            target,
            undefined as never,
            'interrupt_active_work',
            17,
          ),
          { kind: 'target_present' },
        );
        await lifecycle.verifyTargetReady(ROOT_ID, target, undefined as never);
        await lifecycle.finalizeTarget?.(ROOT_ID, target, undefined as never, 17);
        events.push('commit-owner');
        return {
          kind: 'completed',
          record: {
            schemaVersion: 1,
            rootId: ROOT_ID,
            revision: '00000000-0000-4000-8000-000000000000',
            state: { kind: 'owned', owner: OWNER, selected: target },
          },
        };
      }) as never,
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    'observe-old-installation',
    'stage-target',
    'close-preliminary',
    'retire:interrupt_active_work',
    'close-old-host',
    'activate-target',
    'switch-global-package',
    'verify-new-installation',
    'commit-owner',
  ]);
});

function registration(): HostRegistration {
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: ROOT_ID,
    hostEpoch: 'old-host',
    endpoint: '/tmp/maka.sock',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'revision',
    lifecycleMode: 'ephemeral',
    state: 'ready',
    pid: 42,
    createdAt: new Date(0).toISOString(),
  };
}
