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
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IPty } from 'node-pty';
import { type RuntimeHostSshProcessFactory } from '@maka/runtime-host/client';
import {
  encodeRuntimeHostActivationFrame,
  encodeRuntimeHostAccessManagementFrame,
  encodeRuntimeHostPeerManagementFrame,
  encodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostSetupFrame,
  encodeRuntimeHostPeerMeshManagementFrame,
  runtimeHostAccessCredentialFingerprint,
  RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
} from '@maka/runtime-host/operator';
import {
  createDesktopRuntimeHostSshTerminal,
  runtimeHostDevelopmentPeerTargetFromUname,
} from '../runtime-host-ssh-terminal.js';

test('maps supported SSH uname identities to development peer targets', () => {
  assert.equal(runtimeHostDevelopmentPeerTargetFromUname('Linux', 'x86_64'), 'linux-x64');
  assert.equal(runtimeHostDevelopmentPeerTargetFromUname('Linux', 'aarch64'), 'linux-arm64');
  assert.equal(runtimeHostDevelopmentPeerTargetFromUname('Darwin', 'arm64'), 'darwin-arm64');
  assert.throws(
    () => runtimeHostDevelopmentPeerTargetFromUname('Linux', 'riscv64'),
    /not available/u,
  );
});

test('detects the development peer target through the bounded SSH preflight', async () => {
  const harness = createHarness('pending');
  const detection = harness.terminal.resolveDevelopmentPeerTarget({
    destination: 'operator@example.com',
  });
  await waitFor(() => harness.pty.hasDataListener());
  const command = harness.launchArgs[0]?.at(-1) ?? '';
  const marker = command.match(/__MAKA_RUNTIME_HOST_TARGET_[0-9a-f]+__/u)?.[0];
  assert.ok(marker);
  harness.pty.emitData(`${marker}Linux:x86_64\r\n`);
  harness.pty.exit(0);

  assert.equal(await detection, 'linux-x64');
  assert.doesNotMatch(JSON.stringify(harness.events), /MAKA_RUNTIME_HOST_TARGET/u);
  await harness.terminal.close();
});

test('keeps a connecting SSH prompt observable across renderer presentation changes', async () => {
  const harness = createHarness('pending');
  const opening = openTunnel(harness);
  harness.pty.emitData('Password: ');
  const snapshot = await harness.getSnapshot();
  assert.match(JSON.stringify(snapshot), /Password/u);
  assert.equal((snapshot as { kind?: string }).kind, 'connecting');

  harness.releaseTunnel();
  const tunnel = await opening;
  assert.deepEqual(harness.eventKinds(), ['opened', 'data', 'connected']);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 3 });

  const secondTunnel = await openTunnel(harness);

  await tunnel.resource.close();
  await secondTunnel.resource.close();
  await harness.terminal.close();
  assert.equal(harness.handlers.size, 0);
});

test('dismisses a closed SSH prompt from the authoritative presentation', async () => {
  const harness = createHarness('exit');
  const opening = openTunnel(harness);
  harness.pty.emitData('Password: ');
  harness.pty.exit(1);
  await assert.rejects(opening, /SSH exited/u);

  const closed = (await harness.getSnapshot()) as { kind: string; sessionId?: string };
  assert.equal(closed.kind, 'closed');
  assert.ok(closed.sessionId);

  await harness.cancel(closed.sessionId);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 4 });

  await harness.terminal.close();
});

test('does not reopen a cancelled SSH prompt for late process output', async () => {
  const harness = createHarness('exit');
  const opening = openTunnel(harness);
  harness.pty.emitData('Password: ');
  const connecting = (await harness.getSnapshot()) as { sessionId?: string };
  assert.ok(connecting.sessionId);

  await harness.cancel(connecting.sessionId);
  harness.pty.emitData('late output');
  await assert.rejects(opening, /SSH exited/u);

  assert.deepEqual(harness.eventKinds(), ['opened', 'data', 'dismissed']);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 3 });
  await harness.terminal.close();
});

test('keeps setup credentials out of the interactive terminal projection', async () => {
  const harness = createHarness('pending');
  const controller = new AbortController();
  const progress: string[] = [];
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3+desktop.1' },
      principalId: 'desktop:stable-client',
      signal: controller.signal,
    },
    (frame) => progress.push(frame.phase),
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData('Password: ');
  const progressFrame = encodeRuntimeHostSetupFrame({
    schemaVersion: 1,
    sequence: 0,
    kind: 'progress',
    phase: 'installing_service',
  });
  harness.pty.emitData(progressFrame.slice(0, 12));
  harness.pty.emitData(progressFrame.slice(12));
  const completeFrame = encodeRuntimeHostSetupFrame({
    schemaVersion: 1,
    sequence: 1,
    kind: 'complete',
    version: '0.1.0-beta.1',
    serviceId: 'b'.repeat(64),
    deploymentId: '00000000-0000-4000-8000-000000000001',
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credentialId: 'credential-1',
    credential: 'secret-access-token',
  });
  harness.pty.emitData(completeFrame);
  controller.abort();
  await Promise.resolve();
  assert.deepEqual(harness.pty.killSignals, []);
  harness.pty.exit(0);

  const result = await setup;
  assert.equal(result.credential, 'secret-access-token');
  assert.deepEqual(progress, ['installing_service']);
  assert.doesNotMatch(JSON.stringify(harness.events), /secret-access-token|MAKA_RUNTIME/u);
  assert.match(JSON.stringify(harness.events), /Password/u);
  assert.match(harness.launchArgs.at(-1)?.at(-1) ?? '', /mktemp -d/u);
  assert.match(harness.launchArgs.at(-1)?.at(-1) ?? '', /--prefix/u);
  assert.match(harness.launchArgs.at(-1)?.at(-1) ?? '', /trap.*HUP.*trap.*INT.*trap.*TERM/u);
  await harness.terminal.close();
});

test('discards an oversized reserved setup line instead of projecting its tail', async () => {
  const harness = createHarness('pending');
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(`${RUNTIME_HOST_SETUP_FRAME_PREFIX}${'x'.repeat(21 * 1024)}`);
  harness.pty.emitData('"credential":"must-not-reach-renderer"}\nvisible output\n');
  harness.pty.exit(1);

  await assert.rejects(setup, /oversized result/u);
  assert.doesNotMatch(
    JSON.stringify([harness.events, await harness.getSnapshot()]),
    /must-not-reach-renderer/u,
  );
  assert.match(JSON.stringify(harness.events), /visible output/u);
  await harness.terminal.close();
});

test('keeps a completed setup process owned until it exits', async () => {
  const harness = createHarness('pending');
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(encodeRuntimeHostSetupFrame({
    schemaVersion: 1,
    sequence: 0,
    kind: 'complete',
    version: '1.2.3',
    serviceId: 'b'.repeat(64),
    deploymentId: '00000000-0000-4000-8000-000000000001',
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credentialId: 'credential-1',
    credential: 'secret-access-token',
  }));

  await harness.terminal.close();

  assert.deepEqual(harness.pty.killSignals, ['SIGTERM']);
  assert.equal((await setup).credentialId, 'credential-1');
});

test('force-stops a cancelled setup when SSH ignores graceful termination', async () => {
  const harness = createHarness('pending');
  harness.pty.deferKill = true;
  harness.pty.exitOnForceKill = true;
  const controller = new AbortController();
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
      signal: controller.signal,
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData('Password: ');

  controller.abort();

  await assert.rejects(setup, /aborted/u);
  assert.deepEqual(harness.pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(harness.terminatedProcesses, [
    { pid: 42, signal: 'SIGTERM' },
    { pid: 42, signal: 'SIGKILL' },
  ]);
  assert.deepEqual(harness.eventKinds(), ['opened', 'data', 'dismissed']);
  assert.deepEqual(await harness.getSnapshot(), { kind: 'idle', revision: 3 });
  await harness.terminal.close();
});

test('does not signal a reused process identity when cancellation races SSH exit', async () => {
  const harness = createHarness('pending');
  const controller = new AbortController();
  const setup = harness.terminal.runSetup(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.2.3' },
      principalId: 'desktop:stable-client',
      signal: controller.signal,
    },
    () => undefined,
  );
  await waitFor(() => harness.pty.hasDataListener());

  controller.abort();
  harness.pty.exit(0);

  await assert.rejects(setup, /aborted/u);
  await Promise.resolve();
  assert.deepEqual(harness.pty.killSignals, []);
  await harness.terminal.close();
});

test('reads a framed service result without projecting it into the SSH terminal', async () => {
  const harness = createHarness('pending');
  const management = harness.terminal.runServiceManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'status',
    capabilityRequest: RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY,
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/home/operator/.config/Maka/workspaces/default',
      rootId: 'a'.repeat(64),
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  const remoteCommand = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(remoteCommand, /\.local\/share\/maka\/operator/u);
  assert.match(remoteCommand, /MAKA_RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST/u);
  assert.match(remoteCommand, /peer-management-v1/u);
  assert.doesNotMatch(remoteCommand, /npx|maka-agent@/u);
  harness.pty.emitData('Password: ');
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'status',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        stateRoot: '/home/operator/.config/Maka/workspaces/default',
        projectDirectoryRoots: [],
      },
    }),
  );
  harness.pty.exit(0);

  const result = await management;
  assert.equal(result.kind, 'result');
  if (result.kind !== 'result' || result.action !== 'status') {
    assert.fail('expected service status result');
  }
  assert.equal(result.service.installedVersion, '1.2.3');
  assert.doesNotMatch(JSON.stringify(harness.events), /MAKA_RUNTIME_HOST_SERVICE/u);
  assert.match(JSON.stringify(harness.events), /Password/u);
  await harness.terminal.close();
});

test('applies the complete remote Project root policy through the managed operator', async () => {
  const harness = createHarness('pending');
  const fingerprint = `sha256:${'c'.repeat(64)}`;
  const management = harness.terminal.runServiceManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'configure',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
    },
    projectDirectoryRoots: [
      { label: 'Work=Primary', path: '/srv/work trees' },
      { label: 'Data', path: '/mnt/data' },
    ],
    expectedConfigFingerprint: fingerprint,
    allowInterruptActiveTasks: true,
  });
  await waitFor(() => harness.pty.hasDataListener());
  const remoteCommand = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(remoteCommand, /operator.*configure/u);
  assert.match(remoteCommand, /--project-root-json/u);
  assert.match(remoteCommand, /Work=Primary/u);
  assert.match(remoteCommand, /srv\/work trees/u);
  assert.match(remoteCommand, /Data/u);
  assert.match(remoteCommand, /mnt\/data/u);
  assert.match(remoteCommand, /--expected-config-fingerprint/u);
  assert.match(remoteCommand, /--allow-interrupt-active-tasks/u);
  assert.match(
    remoteCommand,
    /MAKA_RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST=1/u,
  );
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'configure',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 43,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        configurationFingerprint: `sha256:${'d'.repeat(64)}`,
        projectDirectoryRoots: [
          { label: 'Work=Primary', path: '/srv/work trees' },
          { label: 'Data', path: '/mnt/data' },
        ],
      },
      configuration: { kind: 'configured' },
    }),
  );
  harness.pty.exit(0);

  const result = await management;
  assert.equal(result.kind, 'result');
  assert.equal(
    result.kind === 'result' && result.action === 'configure'
      ? result.configuration.kind
      : undefined,
    'configured',
  );
  await harness.terminal.close();
});

test('keeps a received management result when SSH teardown times out', async () => {
  const harness = createHarness('pending', { managementTimeoutMs: 1 });
  harness.pty.deferKill = true;
  harness.pty.exitOnForceKill = true;
  const management = harness.terminal.runServiceManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'status',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
    },
  });
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'status',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        projectDirectoryRoots: [],
      },
    }),
  );

  assert.equal((await management).kind, 'result');
  assert.deepEqual(harness.pty.killSignals, ['SIGTERM', 'SIGKILL']);
  await harness.terminal.close();
});

test('runs an exact update package and reports progress before an active-work result', async () => {
  const harness = createHarness('pending');
  const phases: string[] = [];
  const update = harness.terminal.runUpdate(
    {
      destination: 'operator@example.com',
      setupPackage: { kind: 'npm', specifier: 'maka-agent@1.3.0' },
      expectedTarget: {
        serviceId: 'b'.repeat(64),
        rootPath: '/srv/maka',
        rootId: 'a'.repeat(64),
        deploymentId: '00000000-0000-4000-8000-000000000001',
      },
    },
    (phase) => phases.push(phase),
  );
  await waitFor(() => harness.pty.hasDataListener());
  const remoteCommand = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(remoteCommand, /--package.*maka-agent@1\.3\.0/u);
  assert.match(remoteCommand, /runtime-host.*service.*update/u);
  assert.match(remoteCommand, /--managed-root-id.*a{64}/u);
  assert.match(
    remoteCommand,
    /--operator-deployment-id.*00000000-0000-4000-8000-000000000001/u,
  );
  assert.match(remoteCommand, /MAKA_RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST/u);
  harness.pty.emitData('Password: ');
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'progress',
      action: 'update',
      phase: 'retiring',
      currentVersion: '1.2.3',
      targetVersion: '1.3.0',
    }),
  );
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'update',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        projectDirectoryRoots: [],
      },
      update: {
        kind: 'active_tasks',
        currentVersion: '1.2.3',
        targetVersion: '1.3.0',
      },
    }),
  );
  harness.pty.exit(1);

  const result = await update;
  assert.equal(result.kind, 'result');
  assert.equal(result.kind === 'result' ? result.update.kind : undefined, 'active_tasks');
  assert.deepEqual(phases, ['retiring']);
  assert.deepEqual(harness.events.map(({ kind }) => kind), ['opened', 'data', 'connected']);
  assert.doesNotMatch(JSON.stringify(harness.events), /MAKA_RUNTIME_HOST_SERVICE/u);
  await harness.terminal.close();
});

test('uses the managed operator for update policy and one-shot reconciliation', async () => {
  const target = {
    serviceId: 'b'.repeat(64),
    rootPath: '/srv/maka',
    rootId: 'a'.repeat(64),
  };
  const policyHarness = createHarness('pending');
  const policy = policyHarness.terminal.runUpdatePolicy({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    policy: { kind: 'channel', channel: 'latest' },
    expectedTarget: target,
  });
  await waitFor(() => policyHarness.pty.hasDataListener());
  const policyCommand = policyHarness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(policyCommand, /operator.*update-policy.*--target.*latest/u);
  assert.match(policyCommand, /--expected-service-id/u);
  assert.match(policyCommand, /update-scheduler-v1/u);
  policyHarness.pty.emitData(encodeRuntimeHostServiceManagementFrame({
    schemaVersion: 1,
    kind: 'result',
    action: 'update_policy',
    updateSchedulerState: 'ready',
    updatePolicy: {
      policy: { kind: 'channel', channel: 'latest' },
      target,
    },
  }));
  policyHarness.pty.exit(0);
  assert.equal((await policy).kind, 'result');
  await policyHarness.terminal.close();

  const reconcileHarness = createHarness('pending');
  const phases: string[] = [];
  const reconciliation = reconcileHarness.terminal.runUpdateReconciliation(
    {
      destination: 'operator@example.com',
      operatorPath: '/home/operator/.local/share/maka/operator',
      expectedTarget: target,
    },
    (phase) => phases.push(phase),
  );
  await waitFor(() => reconcileHarness.pty.hasDataListener());
  const reconcileCommand = reconcileHarness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(reconcileCommand, /operator.*reconcile-update.*--framed/u);
  assert.match(reconcileCommand, /--expected-service-id/u);
  assert.match(reconcileCommand, /update-scheduler-v1/u);
  reconcileHarness.pty.emitData(encodeRuntimeHostServiceManagementFrame({
    schemaVersion: 1,
    kind: 'progress',
    action: 'reconcile_update',
    phase: 'checking',
    currentVersion: '1.2.3',
    targetVersion: '1.3.0',
  }));
  reconcileHarness.pty.emitData(encodeRuntimeHostServiceManagementFrame({
    schemaVersion: 1,
    kind: 'result',
    action: 'reconcile_update',
    updateSchedulerState: 'ready',
    updatePolicy: {
      policy: { kind: 'channel', channel: 'latest' },
      target,
    },
    service: {
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.8.0',
      state: 'running',
      pid: 42,
      lastExitCode: 0,
      installedVersion: '1.2.3',
      projectDirectoryRoots: [],
    },
    reconciliation: { kind: 'already_current', version: '1.2.3' },
  }));
  reconcileHarness.pty.exit(0);
  assert.equal((await reconciliation).kind, 'result');
  assert.deepEqual(phases, ['checking']);
  await reconcileHarness.terminal.close();
});

test('keeps a prepared access credential out of the SSH terminal projection', async () => {
  const harness = createHarness('pending');
  const credential = 'maka_rh_secret-replacement';
  const management = harness.terminal.runAccessManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootPath: '/srv/maka',
    expectedRootId: 'a'.repeat(64),
    action: 'prepare',
    currentCredentialFingerprint: 'b'.repeat(32),
  });
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData('Password: ');
  harness.pty.emitData(
    encodeRuntimeHostAccessManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'prepare',
      credential,
      credentials: [{
        credentialId: 'credential-2',
        credentialFingerprint: runtimeHostAccessCredentialFingerprint(credential),
        principalKind: 'remote_owner',
        principalId: 'desktop:stable-client',
        status: 'pending',
        operationGrants: ['host.status', 'access.credential.finalize'],
        canPublishClientCapabilities: true,
        canUseHostPaths: false,
        createdAt: '2026-08-21T01:00:00.000Z',
        expiresAt: '2026-08-21T01:15:00.000Z',
      }],
    }),
  );
  harness.pty.exit(0);

  const result = await management;
  assert.equal(result.kind, 'result');
  assert.equal(result.kind === 'result' && result.action === 'prepare' ? result.credential : undefined, credential);
  assert.doesNotMatch(JSON.stringify(harness.events), /secret-replacement|MAKA_RUNTIME/u);
  const command = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(command, /access.*prepare/u);
  assert.match(command, /--current-fingerprint/u);
  assert.match(command, new RegExp('b{32}', 'u'));
  assert.doesNotMatch(command, /secret-replacement/u);
  await harness.terminal.close();
});

test('requests relay-discovery status only on the peer-management frame', async () => {
  const harness = createHarness('pending');
  const management = harness.terminal.runPeerManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'status',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
      deploymentId: '00000000-0000-4000-8000-000000000001',
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  const command = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(command, /peer.*status.*--framed.*--relay-discovery-status/u);

  harness.pty.emitData(
    encodeRuntimeHostPeerManagementFrame({
      kind: 'result',
      action: 'status',
      status: {
        state: 'enabled',
        serviceState: 'running',
        peerId: '12D3KooWpeer',
        rootId: 'a'.repeat(64),
        routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
        coordinationRelays: [],
        automaticRelayDiscovery: true,
      },
    }),
  );
  harness.pty.exit(0);

  const result = await management;
  assert.equal(result.kind === 'result' && result.status.automaticRelayDiscovery, true);
  await harness.terminal.close();
});

test('sends a Mesh invitation only after the authenticated remote operator requests it', async () => {
  const harness = createHarness('pending');
  const invitation = JSON.stringify({ secret: 'one-time-mesh-secret' });
  const management = harness.terminal.runPeerMeshManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'join',
    invitation,
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
      deploymentId: '00000000-0000-4000-8000-000000000001',
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  const command = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(command, /mesh.*join.*--framed/u);
  assert.doesNotMatch(command, /one-time-mesh-secret/u);
  assert.deepEqual(harness.pty.writes, []);

  harness.pty.emitData(
    encodeRuntimeHostPeerMeshManagementFrame({ kind: 'input', action: 'join' }),
  );
  assert.deepEqual(harness.pty.writes, [`${invitation}\r`]);
  harness.pty.emitData(
    encodeRuntimeHostPeerMeshManagementFrame({
      kind: 'result',
      action: 'join',
      result: {
        localPeerId: 'peer-b',
        available: true,
        transit: {
          meshId: null,
          allowedMemberCount: 0,
          activeReservationCount: 0,
          activeCircuitCount: 0,
          maxReservationCount: 32,
          maxCircuitCount: 8,
          maxCircuitsPerPeer: 2,
          maxCircuitDurationSeconds: 7_200,
          maxCircuitBytes: 256 * 1024 * 1024,
        },
        meshes: [
          {
            meshId: 'mesh-id',
            role: 'member',
            authorityPeerId: 'peer-a',
            revision: 2,
            closed: false,
            members: [
              { peerId: 'peer-a', state: 'route_available', expiresAt: Date.now() + 60_000 },
              { peerId: 'peer-b', state: 'local' },
            ],
            pendingInvitationCount: 0,
          },
        ],
      },
    }),
  );
  harness.pty.exit(0);

  assert.equal((await management).kind, 'result');
  assert.doesNotMatch(JSON.stringify(harness.events), /one-time-mesh-secret/u);
  await harness.terminal.close();
});

test('rejects a framed service result for a different action', async () => {
  const harness = createHarness('pending');
  const management = harness.terminal.runServiceManagement({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    action: 'uninstall',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(
    encodeRuntimeHostServiceManagementFrame({
      schemaVersion: 1,
      kind: 'result',
      action: 'status',
      service: {
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.8.0',
        state: 'running',
        pid: 42,
        lastExitCode: 0,
        installedVersion: '1.2.3',
        projectDirectoryRoots: [],
      },
    }),
  );
  harness.pty.exit(0);

  await assert.rejects(management, /returned status for uninstall/u);
  await harness.terminal.close();
});

test('requires an absent operator deployment root to be absent', async () => {
  const harness = createHarness('pending');
  const cleanup = harness.terminal.cleanupManagedDeployment({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    expectedTarget: {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
    },
  });
  await waitFor(() => harness.pty.hasDataListener());
  const remoteCommand = harness.launchArgs.at(-1)?.at(-1) ?? '';
  assert.match(remoteCommand, /if \[ ! -e/u);
  assert.doesNotMatch(remoteCommand, /rmdir --/u);
  assert.match(remoteCommand, /home\/operator\/\.local\/share\/maka/u);
  assert.match(remoteCommand, /__cleanup-managed-deployment/u);
  assert.match(remoteCommand, /--expected-service-id/u);
  assert.match(remoteCommand, /--expected-root-path/u);
  assert.match(remoteCommand, /--expected-root-id/u);
  harness.pty.exit(0);

  await cleanup;
  await harness.terminal.close();
});

test('does not launch a management process after the terminal owner closes', async () => {
  const launches: unknown[] = [];
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    send: () => undefined,
    spawnPty: ((...args: unknown[]) => {
      launches.push(args);
      return new FakePty() as unknown as IPty;
    }) as typeof import('node-pty').spawn,
  });
  await terminal.close();
  await assert.rejects(
    terminal.runServiceManagement({
      destination: 'operator@example.com',
      operatorPath: '/home/operator/.local/share/maka/operator',
      action: 'status',
      expectedTarget: {
        serviceId: 'b'.repeat(64),
        rootPath: '/srv/maka',
        rootId: 'a'.repeat(64),
      },
    }),
    /terminal is closed/u,
  );
  assert.equal(launches.length, 0);
});

test('runs interactive operator activation as one strict framed SSH command', async () => {
  const harness = createHarness('pending');
  const rootId = 'a'.repeat(64);
  const activation = harness.terminal.activateSshOperator({
    destination: 'operator@example.com',
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootId,
    interaction: 'terminal',
  });
  await waitFor(() => harness.pty.hasDataListener());
  harness.pty.emitData(
    encodeRuntimeHostActivationFrame({
      schemaVersion: 1,
      kind: 'result',
      deploymentId: '00000000-0000-4000-8000-000000000001',
      configRevision: 1,
      rootId,
      hostEpoch: 'host-epoch',
      pid: 1234,
      protocolVersion: 1,
      endpoint: { host: '127.0.0.1', port: 43_210, websocketPath: '/runtime-host' },
    }),
  );
  harness.pty.exit(0);

  assert.equal((await activation).pid, 1234);
  const remoteCommand = harness.launchArgs[0]?.at(-1) ?? '';
  assert.match(remoteCommand, /'activate' '--framed' '--root-id'/u);
  assert.match(remoteCommand, new RegExp(rootId, 'u'));
  assert.doesNotMatch(remoteCommand, /credential|token/u);
  await harness.terminal.close();
});

test('uploads a development release archive before running the same remote setup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-development-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'maka-agent-development.tgz');
  await writeFile(archive, 'development package');
  const integrity = `sha512-${createHash('sha512').update('development package').digest('base64')}`;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const launches: Array<{ file: string; args: string[]; pty: FakePty }> = [];
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: () => undefined,
    spawnPty: ((file: string, args: string[]) => {
      const pty = new FakePty();
      launches.push({ file, args, pty });
      return pty as unknown as IPty;
    }) as typeof import('node-pty').spawn,
  });
  t.after(() => terminal.close());

  const setupInput = {
    destination: 'operator@example.com',
    setupPackage: {
      kind: 'development_archive',
      path: archive,
      integrity,
    } as const,
    principalId: 'desktop:stable-client',
  };
  const setup = terminal.runSetup(setupInput, () => undefined);
  await waitFor(() => launches.length === 1);
  assert.equal(launches[0]?.file, 'scp');
  assert.match(launches[0]?.args.at(-2) ?? '', /maka-agent-development\.tgz$/u);
  assert.match(
    launches[0]?.args.at(-1) ?? '',
    /^operator@example\.com:\.\/\.maka-runtime-host-setup-.+\.tgz$/u,
  );
  launches[0]?.pty.exit(0);

  await waitFor(() => launches.length === 2);
  assert.equal(launches[1]?.file, 'ssh');
  const remoteCommand = launches[1]?.args.at(-1) ?? '';
  assert.match(remoteCommand, /--package.*maka-runtime-host-setup-.+\.tgz/u);
  assert.match(remoteCommand, /MAKA_RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY=/u);
  assert.ok(remoteCommand.includes(integrity));
  assert.match(remoteCommand, /--defer-pairing-commit/u);
  assert.match(remoteCommand, /cd.*\$HOME/u);
  assert.match(remoteCommand, /rm -f/u);
  assert.match(remoteCommand, /exec \/bin\/sh -c/u);
  launches[1]?.pty.exit(255);
  await assert.rejects(setup, /exited with code 255/u);
});

function createHarness(
  mode: 'pending' | 'exit',
  options: { readonly managementTimeoutMs?: number } = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: Array<{ kind: string }> = [];
  const terminatedProcesses: Array<{ pid: number; signal: string }> = [];
  const pty = new FakePty();
  const launchArgs: string[][] = [];
  let releaseTunnel!: () => void;
  const tunnelReady = new Promise<void>((resolve) => {
    releaseTunnel = resolve;
  });
  const resource = { closed: pty.exited, close: async () => pty.exit(0) };
  const terminal = createDesktopRuntimeHostSshTerminal({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: (_channel, event) => events.push(event),
    spawnPty: ((_file: string, args: string[]) => {
      launchArgs.push(args);
      return pty as unknown as IPty;
    }) as typeof import('node-pty').spawn,
    revealDelayMs: 0,
    ...options,
    processStopGraceMs: 1,
    terminateProcessTree: async ({ pid, signal, fallback, hasExited, beforeSignal }) => {
      terminatedProcesses.push({ pid, signal });
      await Promise.resolve();
      if (hasExited?.() || beforeSignal?.() === false) return false;
      fallback?.();
      return true;
    },
    openSshTunnel: async (input, overrides) => {
      const spawnProcess = overrides?.spawnProcess as RuntimeHostSshProcessFactory;
      const process = spawnProcess({ executable: 'ssh', args: [], interaction: input.interaction });
      if (mode === 'pending') {
        await tunnelReady;
        return { url: 'ws://127.0.0.1:50000/runtime-host', resource };
      }
      await process.exited;
      throw new Error('SSH exited');
    },
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler({}, ...args);
  };
  return {
    terminal,
    handlers,
    pty,
    launchArgs,
    releaseTunnel,
    eventKinds: () => events.map(({ kind }) => kind),
    events,
    terminatedProcesses,
    getSnapshot: () => invoke('runtime-host-ssh-terminal:getSnapshot'),
    cancel: (sessionId: string) => invoke('runtime-host-ssh-terminal:cancel', sessionId),
  };
}

function openTunnel(harness: ReturnType<typeof createHarness>) {
  return harness.terminal.openSshTunnel({
    destination: 'operator@example.com',
    remotePort: 7443,
    websocketPath: '/runtime-host',
    interaction: 'terminal',
  });
}

class FakePty {
  readonly pid = 42;
  readonly exited: Promise<void>;
  deferKill = false;
  exitOnForceKill = false;
  readonly killSignals: Array<string | undefined> = [];
  readonly writes: string[] = [];
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number; signal: number }) => void>();
  #resolveExit!: () => void;
  #exited = false;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  onData(listener: (data: string) => void) {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal: number }) => void) {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }

  hasDataListener(): boolean {
    return this.#dataListeners.size > 0;
  }

  exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const listener of this.#exitListeners) listener({ exitCode: code, signal: 0 });
    this.#resolveExit();
  }

  write(data: string): void {
    this.writes.push(data);
  }
  resize(): void {}
  kill(signal?: string): void {
    this.killSignals.push(signal);
    if (!this.deferKill || (this.exitOnForceKill && signal === 'SIGKILL')) this.exit(0);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Condition was not reached');
}
