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
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import {
  installRuntimeHostNpmGlobalArchive,
  runRuntimeHostInstalledUpdateCoordinator,
} from '../runtime-host-installed-update-coordinator.js';
import type { RuntimeHostLocalProcessLifecycleAdapter } from '../runtime-host-local-handoff.js';

const ROOT_ID = 'b'.repeat(64);
const INTEGRITY = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;
const OWNER = { kind: 'cli' as const, installationId: 'npm-global:slot' };

function tarHeader(name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'latin1');
  header.write('0000644\0', 100, 'latin1');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write(type, 156, 'latin1');
  header.write('        ', 148, 'latin1');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}

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
        assert.equal(input.ownerInstallationId, OWNER.installationId);
        assert.deepEqual(input.target, target);
        return {
          kind: 'ready',
          settle: async (outcome) => {
            events.push(`settle-target:${outcome}`);
          },
        };
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
    'settle-target:committed',
  ]);
});

test('crash-retry observes its own staged target and never retires or re-activates it', async () => {
  const events: string[] = [];
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
      resolveInstallation: async () =>
        events.includes('switch-global-package')
          ? {
              owner: OWNER,
              observedRelease: {
                ...oldInstallation.observedRelease,
                version: target.version,
              },
            }
          : oldInstallation,
      resolveRoot: async () =>
        ({ kind: 'interactive', canonicalPath: '/state', rootId: ROOT_ID }) as never,
      withArchive: async (_target, archivePath, use) =>
        use({ archivePath, packageRoot: '/temporary/target-package' }),
      prepareStaged: async () => ({
        version: target.version,
        root: '/store',
        packageRoot: '/store/target',
        cliPath: '/store/target/dist/cli.js',
        candidateEntrypoint: '/store/target/runtime-host.js',
        launchGeneration: 'target-generation',
        cleanup: async () => {},
        rollback: async () => {},
      }),
      // The crashed first attempt already activated the staged target: the
      // observed Host carries this transaction's launch generation.
      connectExisting: async () => ({
        kind: 'connected',
        registration: registration({ generation: 'target-generation' }),
        connection: { close: async () => events.push('close-observed-target') } as never,
      }),
      waitForReady: async () => {
        events.push('verify-observed-target-ready');
      },
      prepareRetirement: async () => {
        events.push('retire');
        return { kind: 'prepared', pid: 42 };
      },
      activateTarget: async () => {
        events.push('activate-target');
        return {
          kind: 'ready',
          settle: async (outcome) => {
            events.push(`settle-target:${outcome}`);
          },
        };
      },
      installArchive: async () => {
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
  // No retirement: the live target is recognized as this transaction's own,
  // while a short-lived activator re-attaches as its crash guardian through
  // the pending durable commit.
  assert.deepEqual(events, [
    'close-observed-target', // preliminary observation
    'verify-observed-target-ready',
    'close-observed-target', // the prepare-phase observation of the live target
    'activate-target',
    'switch-global-package',
    'commit-owner',
    'settle-target:committed',
  ]);
});

test('crash-retry with the global package already switched skips the second install', async () => {
  const events: string[] = [];
  const switchedInstallation = {
    owner: OWNER,
    observedRelease: {
      version: '2.0.0',
      packageRoot: '/global/node_modules/maka-agent',
      cliPath: '/global/node_modules/maka-agent/dist/cli.js',
    },
  };
  const target = { kind: 'npm_registry' as const, version: '2.0.0', integrity: INTEGRITY };

  const exitCode = await runRuntimeHostInstalledUpdateCoordinator(
    {
      rootPath: '/state',
      archivePath: '/temporary/target.tgz',
      installedPackageRoot: switchedInstallation.observedRelease.packageRoot,
      installedCliPath: switchedInstallation.observedRelease.cliPath,
      currentVersion: switchedInstallation.observedRelease.version,
      target,
      allowInterruptActiveTasks: false,
    },
    {},
    {
      resolveInstallation: async () => switchedInstallation,
      resolveRoot: async () =>
        ({ kind: 'interactive', canonicalPath: '/state', rootId: ROOT_ID }) as never,
      withArchive: async (_target, archivePath, use) =>
        use({ archivePath, packageRoot: '/temporary/target-package' }),
      prepareStaged: async () => ({
        version: target.version,
        root: '/store',
        packageRoot: '/store/target',
        cliPath: '/store/target/dist/cli.js',
        candidateEntrypoint: '/store/target/runtime-host.js',
        launchGeneration: 'target-generation',
        cleanup: async () => {},
        rollback: async () => {},
      }),
      connectExisting: async () => ({
        kind: 'connected',
        registration: registration({ generation: 'target-generation' }),
        connection: { close: async () => events.push('close-observed-target') } as never,
      }),
      waitForReady: async () => {},
      prepareRetirement: async () => {
        events.push('retire');
        return { kind: 'prepared', pid: 42 };
      },
      activateTarget: async () => {
        events.push('activate-target');
        return {
          kind: 'ready',
          settle: async (outcome) => {
            events.push(`settle-target:${outcome}`);
          },
        };
      },
      installArchive: async () => {
        events.push('switch-global-package');
      },
      reconcile: (async (_request: unknown, lifecycle: RuntimeHostLocalProcessLifecycleAdapter) => {
        assert.deepEqual(
          await lifecycle.prepareHostCutover(
            ROOT_ID,
            target,
            target,
            undefined as never,
            'refuse_active_work',
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
    'close-observed-target',
    'close-observed-target',
    'activate-target',
    'commit-owner',
    'settle-target:committed',
  ]);
});

test('aborts the short-lived target activator when durable ownership cannot commit', async () => {
  const events: string[] = [];
  const installation = {
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
      installedPackageRoot: installation.observedRelease.packageRoot,
      installedCliPath: installation.observedRelease.cliPath,
      currentVersion: installation.observedRelease.version,
      target,
      allowInterruptActiveTasks: false,
    },
    {},
    {
      resolveInstallation: async () => installation,
      resolveRoot: async () =>
        ({ kind: 'interactive', canonicalPath: '/state', rootId: ROOT_ID }) as never,
      withArchive: async (_target, archivePath, use) =>
        use({ archivePath, packageRoot: '/temporary/target-package' }),
      prepareStaged: async () => ({
        version: target.version,
        root: '/store',
        packageRoot: '/store/target',
        cliPath: '/store/target/dist/cli.js',
        candidateEntrypoint: '/store/target/runtime-host.js',
        launchGeneration: 'target-generation',
        cleanup: async () => {},
        rollback: async () => {},
      }),
      connectExisting: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
      activateTarget: async () => ({
        kind: 'ready',
        settle: async (outcome) => {
          events.push(`settle-target:${outcome}`);
        },
      }),
      reconcile: (async (_request: unknown, lifecycle: RuntimeHostLocalProcessLifecycleAdapter) => {
        assert.deepEqual(
          await lifecycle.prepareUnownedHostCutover(
            ROOT_ID,
            target,
            undefined as never,
            'refuse_active_work',
            17,
          ),
          { kind: 'target_present' },
        );
        return {
          kind: 'recovery_required',
          phase: 'commit_handoff',
          cause: new Error('durability'),
        };
      }) as never,
    },
  );
  assert.equal(exitCode, 1);
  assert.deepEqual(events, ['settle-target:abort']);
});

test('rejects extended tar headers before the final global npm switch can spawn', async (t) => {
  const pax = Buffer.from('19 size=4294967296\n');
  const archive = gzipSync(
    Buffer.concat([
      tarHeader('PaxHeader', pax.length, 'x'),
      pax,
      Buffer.alloc(512 - pax.length),
      tarHeader('package/package.json', 0, '0'),
      Buffer.alloc(1024),
    ]),
  );
  const root = await mkdtemp(join(tmpdir(), 'maka-global-pax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = join(root, 'pax.tgz');
  await writeFile(archivePath, archive);
  await assert.rejects(
    installRuntimeHostNpmGlobalArchive(archivePath, 17, (() =>
      assert.fail('PAX archive must not reach npm spawn')) as never),
    /unsupported extended tar header/u,
  );
});

function registration(overrides: Partial<HostRegistration> = {}): HostRegistration {
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
    ...overrides,
  };
}
