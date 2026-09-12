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
import { RuntimeHostRemoteCompatibilityError, type EnvironmentRuntimeHostProfile } from '@maka/runtime-host/client';
import { RUNTIME_HOST_COMPATIBILITY_EPOCH, RUNTIME_HOST_PROTOCOL_VERSION, INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID } from '@maka/runtime-host/protocol';
import { resolveDesktopWslHostHandoff } from '../runtime-host-wsl-handoff.js';

const profile: EnvironmentRuntimeHostProfile = {
  id: 'ubuntu', name: 'Ubuntu', kind: 'environment', rootId: 'a'.repeat(64),
  provider: { kind: 'wsl', distribution: 'Ubuntu' },
  operator: { kind: 'node', platform: 'posix', nodePath: '/usr/bin/node', modulePath: '/operator.mjs' },
};
const binding = {
  profile, state: 'active' as const,
  deployment: { id: profile.rootId, rootPath: '/state', deploymentId: '00000000-0000-4000-8000-000000000001' },
};
function incompatible(epoch = RUNTIME_HOST_COMPATIBILITY_EPOCH - 1) {
  return new RuntimeHostRemoteCompatibilityError(profile.id, {
    kind: 'incompatible', state: 'ready', replacement: 'blocked_by_residency', protocolMin: RUNTIME_HOST_PROTOCOL_VERSION, protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: epoch, compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'test', hostEpoch: 'old-host',
  });
}
const service = {
  platform: 'linux', arch: 'x64', osRelease: '6.6', state: 'running' as const,
  pid: 42, lastExitCode: null, installedVersion: '0.2.0',
  lifecycle: { mode: 'on_demand' as const, availability: 'activation' as const },
  projectDirectoryRoots: [], configurationFingerprint: `sha256:${'b'.repeat(64)}`,
};

test('newer WSL Host offers no downgrade and never resolves an update package', async () => {
  const blocker = await resolveDesktopWslHostHandoff(profile, incompatible(RUNTIME_HOST_COMPATIBILITY_EPOCH + 1), new AbortController().signal, {
    resolveBinding: async () => assert.fail('newer Host must not be managed'),
    resolvePackage: async () => assert.fail('must not stage a downgrade'),
  });
  assert.equal(blocker.replacement, undefined);
  assert.match(blocker.operatorStep!, /Update Desktop/u);
  assert.equal(blocker.manualRecheck, true);
});

test('unbound WSL connection has no mutation authority', async () => {
  const blocker = await resolveDesktopWslHostHandoff(profile, incompatible(), new AbortController().signal, {
    resolveBinding: async () => undefined,
    resolvePackage: async () => assert.fail('unbound target cannot select a package'),
  });
  assert.equal(blocker.replacement, undefined);
});

test('WSL handoff carries exact source identity and separately forwards interruption consent', async () => {
  let changed = false;
  const policies: boolean[] = [];
  const blocker = await resolveDesktopWslHostHandoff(profile, incompatible(), new AbortController().signal, {
    resolveBinding: async () => changed ? undefined : binding,
    resolvePackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.3.0' }),
    status: async () => ({ schemaVersion: 1, kind: 'result', action: 'status', service }),
    update: async (input) => {
      assert.deepEqual(input.expectedHost, { hostEpoch: 'old-host', pid: 42 });
      assert.equal(input.expectedConfigFingerprint, service.configurationFingerprint);
      assert.equal(input.expectedTarget.deploymentId, binding.deployment.deploymentId);
      policies.push(input.allowInterruptActiveTasks);
      return { schemaVersion: 1, kind: 'result', action: 'update', service,
        update: input.allowInterruptActiveTasks
          ? { kind: 'updated', previousVersion: '0.2.0', targetVersion: '0.3.0' }
          : { kind: 'active_tasks', currentVersion: '0.2.0', targetVersion: '0.3.0' },
      };
    },
  });
  assert.equal(blocker.replacement?.requiresExplicitSelection, true);
  assert.deepEqual(await blocker.replacement!.execute('refuse_active_work', () => {}, 'explicit'), { kind: 'active_work' });
  assert.deepEqual(await blocker.replacement!.execute('interrupt_active_work', () => {}, 'explicit'), { kind: 'completed' });
  changed = true;
  assert.deepEqual(await blocker.replacement!.execute('interrupt_active_work', () => {}, 'explicit'), { kind: 'changed' });
  assert.deepEqual(policies, [false, true]);
});


test('legacy operator without a configuration fingerprint remains fenced by source version and Host identity', async () => {
  const { configurationFingerprint: _fingerprint, ...legacyService } = service;
  const blocker = await resolveDesktopWslHostHandoff(profile, incompatible(), new AbortController().signal, {
    resolveBinding: async () => binding,
    resolvePackage: async () => ({
      kind: 'development_archive', path: '/selected.tgz', integrity: 'sha512-selected',
      displayVersion: '0.3.0-dev-abcdef012345',
    }),
    status: async () => ({ schemaVersion: 1, kind: 'result', action: 'status', service: legacyService }),
    update: async (input) => {
      assert.equal(input.expectedConfigFingerprint, undefined);
      assert.equal(input.expectedSourceVersion, legacyService.installedVersion);
      assert.deepEqual(input.expectedHost, { hostEpoch: 'old-host', pid: 42 });
      assert.equal(input.expectedTarget.deploymentId, binding.deployment.deploymentId);
      return { schemaVersion: 1, kind: 'error', action: 'update', error: { code: 'target_mismatch', message: 'Source changed under deployment lock' } };
    },
  });
  assert.ok(blocker.replacement);
  assert.deepEqual(blocker.packageChange, {
    current: legacyService.installedVersion,
    target: '0.3.0-dev-abcdef012345',
  });
  assert.deepEqual(await blocker.replacement.execute('refuse_active_work', () => {}, 'explicit'), { kind: 'changed' });
});

test('development handoff never presents package integrity as a version', async () => {
  const blocker = await resolveDesktopWslHostHandoff(profile, incompatible(), new AbortController().signal, {
    resolveBinding: async () => binding,
    resolvePackage: async () => ({
      kind: 'development_archive', path: '/selected.tgz', integrity: 'sha512-selected',
    }),
    status: async () => ({ schemaVersion: 1, kind: 'result', action: 'status', service }),
    update: async () => assert.fail('displaying the package change must not start an update'),
  });
  assert.deepEqual(blocker.packageChange, {
    current: service.installedVersion,
    target: 'selected development build',
  });
});
