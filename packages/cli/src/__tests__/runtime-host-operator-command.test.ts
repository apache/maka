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
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { decodeRuntimeHostActivationFrame } from '@maka/runtime-host/operator';
import {
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import { runRuntimeHostManagedActivationCli } from '../runtime-host-activation-command.js';
import {
  resolveRuntimeHostAccessIssue,
  type RuntimeHostAccessIssueOptions,
} from '../runtime-host-access-command.js';
import { parseRuntimeHostCommand } from '../runtime-host-cli.js';
import { runRuntimeHostPluginCli } from '../runtime-host-plugin-command.js';
import { runRuntimeHostProjectCli } from '../runtime-host-project-command.js';
import { createRuntimeHostServiceReadyEvent } from '../runtime-host-service-command.js';

const projectRootA = process.platform === 'win32' ? 'C:\\srv\\projects' : '/srv/projects';
const projectRootB = process.platform === 'win32' ? 'D:\\data' : '/mnt/data';
const operatorClientDataRoot =
  process.platform === 'win32' ? 'C:\\maka-control' : '/srv/maka-control';

describe('Runtime Host operator commands', () => {
  test('parses resident Peer Mesh management without accepting invitations in argv', () => {
    const target = {
      serviceId: 'b'.repeat(64),
      rootPath: '/srv/maka',
      rootId: 'a'.repeat(64),
      deploymentId: '00000000-0000-4000-8000-000000000001',
    };
    const base = [
      '--client-data-root',
      operatorClientDataRoot,
      '--managed-root-id',
      target.rootId,
      '--operator-deployment-id',
      target.deploymentId,
      '--expected-service-id',
      target.serviceId,
      '--expected-root-path',
      target.rootPath,
      '--expected-root-id',
      target.rootId,
      '--expected-deployment-id',
      target.deploymentId,
    ];
    assert.deepEqual(parseRuntimeHostCommand(['service', 'mesh', 'join', '--framed', ...base]), {
      kind: 'runtime-host-service-peer-mesh',
      action: 'join',
      json: false,
      framed: true,
      managedRootId: target.rootId,
      operatorDeploymentId: target.deploymentId,
      expectedTarget: target,
    });
    assert.equal(
      parseRuntimeHostCommand(['service', 'mesh', 'join', '--invitation', 'secret', ...base]).kind,
      'error',
    );
    assert.deepEqual(parseRuntimeHostCommand(['service', 'mesh', 'transit', '--off', ...base]), {
      kind: 'runtime-host-service-peer-mesh',
      action: 'transit',
      json: false,
      managedRootId: target.rootId,
      operatorDeploymentId: target.deploymentId,
      expectedTarget: target,
      meshId: null,
    });
  });

  test('parses and emits the stable framed managed activation contract', async () => {
    const rootId = 'a'.repeat(64);
    assert.deepEqual(parseRuntimeHostCommand(['activate', '--framed', '--root-id', rootId]), {
      kind: 'runtime-host-managed-activate',
      rootId,
      framed: true,
    });
    assert.equal(parseRuntimeHostCommand(['activate', '--root-id', rootId]).kind, 'error');
    assert.deepEqual(
      parseRuntimeHostCommand([
        'connect',
        '--framed',
        '--root-id',
        rootId,
        '--repair-root-after-remount',
      ]),
      {
        kind: 'runtime-host-managed-connect',
        rootId,
        framed: true,
        repairRootAfterRemount: true,
      },
    );

    let output = '';
    assert.equal(
      await runRuntimeHostManagedActivationCli(
        { rootId },
        {
          activate: async () => ({
            schemaVersion: 1,
            kind: 'result',
            deploymentId: '00000000-0000-4000-8000-000000000001',
            configRevision: 1,
            rootId,
            hostEpoch: 'host-epoch',
            pid: 1234,
            protocolVersion: RUNTIME_HOST_PROTOCOL_VERSION,
            endpoint: {
              host: '127.0.0.1',
              port: 43_210,
              websocketPath: '/runtime-host',
            },
          }),
          writeOutput: (value) => {
            output += value;
          },
        },
      ),
      0,
    );
    assert.equal(decodeRuntimeHostActivationFrame(output)?.kind, 'result');
  });
  test('parses project management and machine-readable service readiness', () => {
    assert.deepEqual(parseRuntimeHostCommand(['project', 'list', '--root', '/srv/maka']), {
      kind: 'runtime-host-project-list',
      rootPath: '/srv/maka',
    });
    assert.deepEqual(
      parseRuntimeHostCommand(['project', 'add', '/work/project', '--root', '/srv/maka']),
      {
        kind: 'runtime-host-project-add',
        rootPath: '/srv/maka',
        path: '/work/project',
        prefer: false,
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'plugin',
        'inspect',
        '--scope',
        'profile',
        '--cursor',
        'opaque-cursor',
        '--limit',
        '16',
      ]),
      {
        kind: 'runtime-host-plugin',
        action: 'inspect',
        rootId: 'profile',
        cursor: 'opaque-cursor',
        limit: 16,
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand(['plugin', 'export', 'fixture-plugin', './fixture.maka-extension']),
      {
        kind: 'runtime-host-plugin',
        action: 'export',
        subject: 'fixture-plugin',
        targetPath: './fixture.maka-extension',
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'project',
        'add',
        '/work/project',
        '--prefer',
        '--root',
        '/srv/maka',
      ]),
      {
        kind: 'runtime-host-project-add',
        rootPath: '/srv/maka',
        path: '/work/project',
        prefer: true,
      },
    );
    assert.deepEqual(parseRuntimeHostCommand(['serve', '--json', '--no-project-roots']), {
      kind: 'runtime-host-serve',
      json: true,
      projectDirectoryRoots: [],
    });
    assert.deepEqual(
      parseRuntimeHostCommand([
        'serve',
        '--json',
        '--project-root',
        `Projects=${projectRootA}`,
        '--project-root',
        `Data=${projectRootB}`,
      ]),
      {
        kind: 'runtime-host-serve',
        json: true,
        projectDirectoryRoots: [
          { label: 'Projects', path: projectRootA },
          { label: 'Data', path: projectRootB },
        ],
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'serve',
        '--project-root-json',
        JSON.stringify({ label: 'Work=Primary', path: projectRootA }),
      ]),
      {
        kind: 'runtime-host-serve',
        json: false,
        projectDirectoryRoots: [{ label: 'Work=Primary', path: projectRootA }],
      },
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'serve',
        '--managed-service-config',
        '/config/Maka/runtime-host-service.json',
        '--json',
      ]),
      {
        kind: 'runtime-host-serve',
        managedServiceConfigPath: '/config/Maka/runtime-host-service.json',
        json: true,
      },
    );
    assert.equal(
      parseRuntimeHostCommand([
        'serve',
        '--managed-service-config',
        '/config/Maka/runtime-host-service.json',
        '--root',
        '/srv/maka',
      ]).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand([
        'serve',
        '--managed-service-config',
        '/config/Maka/runtime-host-service.json',
        '--peer-native-path',
        '/opt/maka/peer.node',
        '--peer-key',
        '/config/Maka/peer.key',
      ]).kind,
      'error',
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'serve',
        '--websocket-host',
        '0.0.0.0',
        '--websocket-port',
        '7443',
        '--allow-insecure-remote',
      ]),
      {
        kind: 'runtime-host-serve',
        json: false,
        websocket: { host: '0.0.0.0', port: 7443, allowInsecureRemote: true },
      },
    );
    assert.equal(
      parseRuntimeHostCommand([
        'serve',
        '--websocket-port',
        '7443',
        '--allow-insecure-remote',
        '--tls-certificate',
        'cert.pem',
        '--tls-private-key',
        'key.pem',
      ]).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand(['serve', '--project-root', 'Projects=relative/path']).kind,
      'error',
    );
    assert.equal(
      parseRuntimeHostCommand([
        'serve',
        '--project-root',
        `Projects=${projectRootA}`,
        '--project-root',
        `Projects=${projectRootB}`,
      ]).kind,
      'error',
    );
  });

  test('expands access presets without access administration or Host paths', () => {
    const desktop = resolveRuntimeHostAccessIssue(presetOptions('desktop-client'));
    const terminal = resolveRuntimeHostAccessIssue(presetOptions('terminal-client'));

    for (const resolved of [desktop, terminal]) {
      assert.equal(resolved.principalKind, 'remote_owner');
      assert.equal(resolved.canUseHostPaths, false);
      assert.equal(resolved.operationGrants.includes('access.credential.issue'), false);
      assert.equal(resolved.operationGrants.includes('access.credential.prepare'), false);
      assert.equal(resolved.operationGrants.includes('access.credential.replace'), false);
      assert.equal(resolved.operationGrants.includes('access.credential.revoke'), false);
      assert.equal(resolved.operationGrants.includes('access.credential.rotation.prepare'), false);
      assert.equal(resolved.operationGrants.includes('access.credential.rotation.revoke'), false);
      assert.equal(resolved.operationGrants.includes('host.upgrade.prepare'), false);
      assert.equal(resolved.operationGrants.includes('plugin.platform.query'), false);
      assert.equal(resolved.operationGrants.includes('plugin.package.install'), false);
      assert.equal(resolved.operationGrants.includes('turn.start'), true);
      assert.equal(resolved.operationGrants.includes('project.catalog.query'), true);
    }
    assert.equal(desktop.canPublishClientCapabilities, true);
    assert.equal(desktop.operationGrants.includes('client.capability.replace'), true);
    assert.equal(terminal.canPublishClientCapabilities, false);
    assert.equal(terminal.operationGrants.includes('client.capability.replace'), false);
    assert.equal(
      parseRuntimeHostCommand([
        'access',
        'issue',
        '--principal',
        'desktop',
        '--preset',
        'desktop-client',
        '--grant',
        'turn.start',
      ]).kind,
      'error',
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'access',
        'issue',
        '--kind',
        'capability-provider',
        '--principal',
        'terminal-mcp-provider',
        '--capability-owner-credential',
        'terminal-owner-credential',
      ]),
      {
        kind: 'runtime-host-access-issue',
        principalKind: 'capability_provider',
        principalId: 'terminal-mcp-provider',
        operationGrants: ['client.capability.replace', 'client.capability.unregister'],
        canPublishClientCapabilities: true,
        canUseHostPaths: false,
        capabilityOwnerCredentialId: 'terminal-owner-credential',
      },
    );
    assert.equal(
      parseRuntimeHostCommand([
        'access',
        'issue',
        '--principal',
        'terminal-owner',
        '--grant',
        'session.catalog.query',
        '--capability-owner-credential',
        'terminal-owner-credential',
      ]).kind,
      'error',
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'access',
        'prepare',
        '--current-fingerprint',
        'a'.repeat(32),
        '--root',
        '/srv/maka',
        '--expected-root',
        'a'.repeat(64),
        '--framed',
      ]),
      {
        kind: 'runtime-host-access-prepare',
        rootPath: '/srv/maka',
        expectedRootId: 'a'.repeat(64),
        currentCredentialFingerprint: 'a'.repeat(32),
      },
    );
    assert.equal(
      parseRuntimeHostCommand(['access', 'prepare', '--current-fingerprint', 'a'.repeat(32)]).kind,
      'error',
    );
    assert.deepEqual(parseRuntimeHostCommand(['access', 'list', '--framed']), {
      kind: 'runtime-host-access-list',
      framed: true,
    });
    assert.deepEqual(
      parseRuntimeHostCommand([
        'access',
        'connection-code',
        '--name',
        'Office Host',
        '--root',
        '/srv/maka',
        '--expected-root',
        'a'.repeat(64),
        '--framed',
      ]),
      {
        kind: 'runtime-host-access-connection-code',
        name: 'Office Host',
        rootPath: '/srv/maka',
        expectedRootId: 'a'.repeat(64),
        framed: true,
      },
    );
    assert.equal(
      parseRuntimeHostCommand(['access', 'connection-code', '--principal', 'unexpected']).kind,
      'error',
    );
    assert.deepEqual(
      parseRuntimeHostCommand([
        'access',
        'revoke',
        '--credential',
        'credential-1',
        '--current-fingerprint',
        'a'.repeat(32),
        '--framed',
      ]),
      {
        kind: 'runtime-host-access-revoke',
        credentialId: 'credential-1',
        currentCredentialFingerprint: 'a'.repeat(32),
        framed: true,
      },
    );
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS)
        .filter(
          (operation) =>
            !REMOTE_OWNER_OPERATION_GRANTS.includes(
              operation as (typeof REMOTE_OWNER_OPERATION_GRANTS)[number],
            ),
        )
        .sort(),
      [
        'access.credential.issue',
        'access.credential.prepare',
        'access.credential.replace',
        'access.credential.revoke',
        'access.credential.rotation.prepare',
        'access.credential.rotation.revoke',
        'access.principal.revoke',
        'collaboration.turn-request.acknowledge',
        'collaboration.turn-request.create',
        'host.upgrade.prepare',
        'hosted.execution.cancel',
        'hosted.execution.start',
        'peer.mesh.close',
        'peer.mesh.create',
        'peer.mesh.display-name.set',
        'peer.mesh.invite',
        'peer.mesh.join',
        'peer.mesh.leave',
        'peer.mesh.query',
        'peer.mesh.reconcile',
        'peer.mesh.remove',
        'peer.mesh.rename',
        'peer.mesh.transit.set',
        'plugin.composition.apply',
        'plugin.package.export',
        'plugin.package.install',
        'plugin.package.reload',
        'plugin.package.uninstall',
        'plugin.platform.query',
        'plugin.platform.reconcile',
      ],
    );
  });

  test('emits bounded service identity and listener facts without credentials', () => {
    const event = createRuntimeHostServiceReadyEvent({
      rootId: 'a'.repeat(64),
      hostEpoch: 'epoch-1',
      endpoint: '/tmp/maka.sock',
      websocketEndpoints: ['wss://runtime.example.com:443/runtime-host'],
      peerListeners: [
        {
          reachability: {
            lease: {
              version: 1,
              peerId: '12D3KooWPeer',
              revision: 1,
              issuedAt: 1,
              expiresAt: 2,
              directRoutes: ['/ip4/192.0.2.10/udp/4001/quic-v1/p2p/12D3KooWPeer'],
              coordinationRoutes: [],
            },
            publicKey: 'cHVibGlj',
            signature: 'c2lnbmF0dXJl',
          },
        },
      ],
      compositionDescriptor: { id: 'maka.interactive', revision: '2' },
    });

    assert.deepEqual(event, {
      schemaVersion: 1,
      event: 'runtime_host_ready',
      rootId: 'a'.repeat(64),
      hostEpoch: 'epoch-1',
      protocol: {
        version: RUNTIME_HOST_PROTOCOL_VERSION,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      },
      composition: { id: 'maka.interactive', revision: '2' },
      listeners: [
        { kind: 'local_ipc', endpoint: '/tmp/maka.sock' },
        {
          kind: 'websocket',
          tls: true,
          host: 'runtime.example.com',
          port: 443,
          path: '/runtime-host',
        },
        {
          kind: 'libp2p_direct',
          peerId: '12D3KooWPeer',
          listenAddresses: ['/ip4/192.0.2.10/udp/4001/quic-v1/p2p/12D3KooWPeer'],
        },
      ],
    });
    assert.equal(JSON.stringify(event).includes('credential'), false);
  });

  test('registers a Project without preferring it unless explicitly requested', async () => {
    let closeCount = 0;
    const requests: unknown[] = [];
    const connection = {
      request: async (operation: string, input: unknown) => {
        requests.push({ operation, input });
        return {
          kind: 'project',
          project: {
            id: 'project-1',
            aliases: [],
            name: 'project',
            locationCount: 1,
            archivedAt: null,
            available: true,
          },
        };
      },
      close: async () => {
        closeCount += 1;
      },
    } as unknown as RuntimeHostConnection;
    const output: string[] = [];
    const commands = [
      { kind: 'add' as const, rootPath: '/srv/maka', path: 'project', prefer: false },
      { kind: 'add' as const, rootPath: '/srv/maka', path: 'project', prefer: true },
    ];

    for (const command of commands) {
      assert.equal(
        await runRuntimeHostProjectCli(command, {
          connect: async () => connection,
          write: (value) => output.push(value),
        }),
        0,
      );
    }
    assert.deepEqual(requests, [
      {
        operation: 'project.catalog.mutate',
        input: { kind: 'register', path: resolve('project'), prefer: false },
      },
      {
        operation: 'project.catalog.mutate',
        input: { kind: 'register', path: resolve('project'), prefer: true },
      },
    ]);
    assert.equal(closeCount, 2);
    assert.deepEqual(
      output.map((value) => (JSON.parse(value) as { project: { id: string } }).project.id),
      ['project-1', 'project-1'],
    );
  });

  test('uses every Plugin Platform surface through the Runtime Host', async () => {
    const requests: unknown[] = [];
    let closeCount = 0;
    const connection = {
      request: async (operation: string, input: unknown) => {
        requests.push({ operation, input });
        return {};
      },
      close: async () => {
        closeCount += 1;
      },
    } as unknown as RuntimeHostConnection;
    const overrides = {
      connect: async () => connection,
      readText: async () => '{"operations":[{"type":"remove","entryId":"entry-one"}]}',
      write: () => undefined,
    };
    const commands = [
      { rootPath: '/srv/maka', action: 'status' as const },
      { rootPath: '/srv/maka', action: 'list' as const },
      { rootPath: '/srv/maka', action: 'inspect' as const, rootId: 'profile' },
      { rootPath: '/srv/maka', action: 'failures' as const },
      { rootPath: '/srv/maka', action: 'install' as const, subject: './plugin' },
      { rootPath: '/srv/maka', action: 'uninstall' as const, subject: 'plugin' },
      { rootPath: '/srv/maka', action: 'reload' as const, subject: 'plugin' },
      {
        rootPath: '/srv/maka',
        action: 'export' as const,
        subject: 'plugin',
        targetPath: './plugin.maka-extension',
      },
      { rootPath: '/srv/maka', action: 'apply' as const, subject: './operations.json' },
      { rootPath: '/srv/maka', action: 'reconcile' as const },
    ];
    for (const command of commands) {
      assert.equal(await runRuntimeHostPluginCli(command, overrides), 0);
    }
    assert.deepEqual(
      requests.map((request) => (request as { operation: string }).operation),
      [
        'plugin.platform.query',
        'plugin.platform.query',
        'plugin.platform.query',
        'plugin.platform.query',
        'plugin.package.install',
        'plugin.package.uninstall',
        'plugin.package.reload',
        'plugin.package.export',
        'plugin.composition.apply',
        'plugin.platform.reconcile',
      ],
    );
    assert.equal(closeCount, commands.length);
  });
});

function presetOptions(
  preset: 'desktop-client' | 'terminal-client',
): RuntimeHostAccessIssueOptions {
  return {
    rootPath: '/srv/maka',
    principalKind: 'remote_owner',
    principalId: preset,
    operationGrants: [],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
    preset,
  };
}
