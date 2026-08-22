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
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveRootControlNamespace, resolveStorageRoot } from '@maka/storage/root-authority';
import { classifyRemoteRuntimeHostConnectFailure } from '../client/connection.js';
import {
  connectRemoteRuntimeHostProfile,
  connectRemoteRuntimeHost,
  connectRuntimeHost,
  consumeAccessCredentialDelivery,
  createRuntimeHostReconnectingConnection,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT } from '../client/host-profile.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
  type RequestFrame,
} from '../protocol/index.js';
import { openRuntimeHostAccessAuthority } from '../server/access-authority.js';
import {
  RuntimeHostAccessCommitOutcomeUnknownError,
  writeAccessCredentialFile,
} from '../server/access-credential-store.js';
import { startExecutionRuntimeHostService } from '../server/execution-service.js';
import { authorizeRuntimeHostOperation } from '../server/connection-authority.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const KNOWN_EMPTY_LIVE_RUN_STATE = {
  schemaVersion: SESSION_CATALOG_LIVE_RUN_STATE_SCHEMA_VERSION,
  runningTurnIds: [],
} as const;

test('one Local IPC owner and one authenticated WebSocket Client control the same Session', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-authenticated-websocket-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const host = await startExecutionRuntimeHostService({
    rootPath: root,
    websocket: { host: '127.0.0.1', port: 0 },
  });
  let local: RuntimeHostConnection | undefined;
  let remote: RuntimeHostConnection | undefined;
  try {
    local = requireConnection(await connectRuntimeHost({ rootPath: root, protocol: PROTOCOL }));
    const issued = await local.request('access.credential.issue', {
      principalKind: 'remote_owner',
      principalId: 'remote-device',
      operationGrants: [
        'session.catalog.query',
        'session.metadata.update',
        'session.create',
        'client.capability.replace',
        'project.catalog.query',
        'project.catalog.mutate',
        'skill.catalog.query',
        'access.credential.finalize',
      ],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const credential = await consumeAccessCredentialDelivery(
      root,
      issued.deliveryId,
      issued.credentialId,
    );
    const url = host.websocketEndpoints[0];
    assert.ok(url);
    await assert.rejects(
      connectRemoteRuntimeHost({
        url: `${url}?route=forbidden`,
        credential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        protocol: PROTOCOL,
      }),
      /must not contain credentials, a query, or a fragment/u,
    );

    const wrongRoot = await connectRemoteRuntimeHost({
      url,
      credential,
      expectedRootId: 'f'.repeat(64),
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: PROTOCOL,
    });
    assert.deepEqual(wrongRoot, { kind: 'unavailable', reason: 'root_mismatch' });

    const wrongComposition = await connectRemoteRuntimeHost({
      url,
      credential,
      expectedRootId: capability.rootId,
      compositionId: 'test.other',
      protocol: PROTOCOL,
    });
    assert.equal(wrongComposition.kind, 'incompatible');
    if (wrongComposition.kind === 'incompatible') {
      assert.equal(wrongComposition.handshake.hostEpoch, host.hostEpoch);
      assert.equal(
        wrongComposition.handshake.compositionId,
        INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      );
      assert.equal(
        wrongComposition.handshake.compositionRevision,
        host.compositionDescriptor.revision,
      );
      assert.equal(wrongComposition.handshake.replacement, 'blocked_by_residency');
    }

    const connected = await connectRemoteRuntimeHost({
      url,
      credential,
      expectedRootId: capability.rootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: PROTOCOL,
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') assert.fail('WebSocket Client did not connect');
    remote = connected.connection;
    assert.equal(remote.rootId, local.rootId);
    assert.equal(remote.hostEpoch, local.hostEpoch);
    await assert.rejects(
      remote.request('host.diagnostics.query', {}),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    const remoteProjects = await remote.request('project.catalog.query', {
      kind: 'list_start',
      view: 'summary',
    });
    assert.equal(remoteProjects.kind, 'page');
    await assert.rejects(
      remote.request('project.catalog.mutate', {
        kind: 'register',
        path: root,
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );

    const registered = await local.request('project.catalog.mutate', {
      kind: 'register',
      path: root,
    });
    assert.equal(registered.kind, 'project');
    if (registered.kind !== 'project') assert.fail('Project registration did not commit');
    const registeredProjectId = registered.project.id;
    const canonicalRoot = await realpath(root);
    await assert.rejects(
      remote.request('project.catalog.query', { kind: 'list_start', view: 'locations' }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    const remoteSkills = await remote.request('skill.catalog.query', {
      kind: 'start',
      context: {
        workspace: { kind: 'project', projectId: registeredProjectId },
      },
      view: 'governance',
    });
    assert.equal(remoteSkills.kind, 'page');
    await assert.rejects(
      remote.request('skill.catalog.query', {
        kind: 'start',
        context: { workspace: { kind: 'host_path', path: canonicalRoot } },
        view: 'governance',
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    const remoteProjectSession = await remote.request('session.create', {
      sessionId: 'remote-project-session',
      workspace: { kind: 'project', projectId: registeredProjectId },
      modelTarget: { kind: 'default' },
    });
    assert.ok(!('kind' in remoteProjectSession));
    if (!('kind' in remoteProjectSession)) {
      assert.deepEqual(remoteProjectSession.workspace, {
        target: { kind: 'project', projectId: registeredProjectId },
        hostCwd: canonicalRoot,
      });
    }

    const created = await local.request('session.create', {
      sessionId: 'shared-session',
      workspace: { kind: 'host_path', path: root },
      name: 'Shared Session',
      modelTarget: { kind: 'default' },
    });
    assert.ok(!('kind' in created));
    assert.deepEqual(
      await remote.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'shared-session',
      }),
      {
        kind: 'session',
        session: { ...created, liveRunState: KNOWN_EMPTY_LIVE_RUN_STATE },
      },
    );

    const catalogChanged = new Promise<string>((resolve) => {
      local?.subscribeSessionCatalogChanges((frame) => resolve(frame.sessionId));
    });
    const renamed = await remote.request('session.metadata.update', {
      sessionId: 'shared-session',
      expectedRevision: created.revision,
      patch: { name: 'Renamed remotely' },
    });
    assert.equal(renamed.kind, 'committed');
    assert.equal(await catalogChanged, 'shared-session');
    assert.deepEqual(
      await local.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'shared-session',
      }),
      renamed.kind === 'committed'
        ? {
            kind: 'session',
            session: { ...renamed.session, liveRunState: KNOWN_EMPTY_LIVE_RUN_STATE },
          }
        : assert.fail('Remote Session rename did not commit'),
    );

    await assert.rejects(
      remote.request('session.create', {
        sessionId: 'remote-path-session',
        workspace: { kind: 'host_path', path: root },
        modelTarget: { kind: 'default' },
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    await assert.rejects(
      remote.replaceClientCapabilities({
        offers: () => [
          {
            offerId: 'test',
            version: '1',
            affinity: 'call',
            hostPathAccess: 'cwd',
            label: 'Test',
            tools: [
              {
                serverId: 'test',
                name: 'noop',
                inputSchema: { type: 'object' },
              },
            ],
          },
        ],
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    const providerIssued = await local.request('access.credential.issue', {
      principalKind: 'capability_provider',
      principalId: 'remote-provider',
      operationGrants: ['client.capability.replace', 'client.capability.unregister'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
    });
    const providerCredential = await consumeAccessCredentialDelivery(
      root,
      providerIssued.deliveryId,
      providerIssued.credentialId,
    );
    const providerConnected = await connectRemoteRuntimeHost({
      url,
      credential: providerCredential,
      expectedRootId: capability.rootId,
      protocol: PROTOCOL,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      clientInstanceId: 'remote-provider-instance',
    });
    assert.equal(providerConnected.kind, 'connected');
    if (providerConnected.kind !== 'connected') assert.fail('Capability provider did not connect');
    try {
      await providerConnected.connection.replaceClientCapabilities({
        offers: () => [
          {
            offerId: 'path-independent',
            version: '1',
            affinity: 'session',
            hostPathAccess: 'none',
            label: 'Path independent',
            tools: [
              {
                serverId: 'remote',
                name: 'inspect',
                inputSchema: { type: 'object' },
              },
            ],
          },
        ],
      });
      await assert.rejects(
        providerConnected.connection.replaceClientCapabilities({
          offers: () => [
            {
              offerId: 'host-path',
              version: '1',
              affinity: 'session',
              hostPathAccess: 'cwd',
              label: 'Host path',
              tools: [
                {
                  serverId: 'remote',
                  name: 'inspect_path',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          ],
        }),
        (error: unknown) =>
          error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
      );
    } finally {
      await providerConnected.connection.close();
    }
    assert.equal(
      (
        await remote.request('session.catalog.query', {
          kind: 'get',
          sessionId: 'shared-session',
        })
      ).kind,
      'session',
    );

    const candidate = await local.request('access.credential.prepare', {
      principalKind: 'remote_owner',
      principalId: 'remote-device',
      operationGrants: issued.operationGrants,
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const replacementCredential = await consumeAccessCredentialDelivery(
      root,
      candidate.deliveryId,
      candidate.credentialId,
    );
    assert.deepEqual(await remote.request('access.credential.finalize', {}), {});
    const replacementConnection = await connectRemoteRuntimeHost({
      url,
      credential: replacementCredential,
      expectedRootId: capability.rootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: PROTOCOL,
    });
    assert.equal(replacementConnection.kind, 'connected');
    if (replacementConnection.kind === 'connected') {
      assert.deepEqual(
        await replacementConnection.connection.request('access.credential.finalize', {}),
        {},
      );
      await remote.closed;
      remote = undefined;
      assert.deepEqual(
        await replacementConnection.connection.request('access.credential.finalize', {}),
        {},
      );
      await replacementConnection.connection.close();
    }
    assert.deepEqual(
      await connectRemoteRuntimeHost({
        url,
        credential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        protocol: PROTOCOL,
      }),
      { kind: 'unavailable', reason: 'authentication_failed' },
    );
    assert.deepEqual(
      await local.request('access.credential.revoke', { credentialId: candidate.credentialId }),
      { credentialId: candidate.credentialId, revoked: true },
    );
  } finally {
    await Promise.allSettled([remote?.close(), local?.close()]);
    await host.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('classifies safe remote connection failures without exposing raw errors', () => {
  assert.equal(
    classifyRemoteRuntimeHostConnectFailure(
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    ),
    'unreachable',
  );
  assert.equal(
    classifyRemoteRuntimeHostConnectFailure(
      Object.assign(new Error('certificate details'), { code: 'CERT_HAS_EXPIRED' }),
    ),
    'tls_failed',
  );
  assert.equal(
    classifyRemoteRuntimeHostConnectFailure(new Error('unexpected sensitive detail')),
    'connect_failed',
  );
});

test('an authenticated WebSocket Client reconnects after service restart to canonical state', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-authenticated-websocket-restart-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let host: Awaited<ReturnType<typeof startExecutionRuntimeHostService>> | undefined =
    await startExecutionRuntimeHostService({
      rootPath: root,
      websocket: { host: '127.0.0.1', port: 0 },
    });
  let local: RuntimeHostConnection | undefined;
  let remote: Awaited<ReturnType<typeof createRuntimeHostReconnectingConnection>> | undefined;
  try {
    local = requireConnection(await connectRuntimeHost({ rootPath: root, protocol: PROTOCOL }));
    const issued = await local.request('access.credential.issue', {
      principalKind: 'remote_owner',
      principalId: 'restart-client',
      operationGrants: ['host.status', 'session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const credential = await consumeAccessCredentialDelivery(
      root,
      issued.deliveryId,
      issued.credentialId,
    );
    const created = await local.request('session.create', {
      sessionId: 'session-before-restart',
      workspace: { kind: 'host_path', path: root },
      name: 'Created before restart',
      modelTarget: { kind: 'default' },
    });
    assert.ok(!('kind' in created));

    const url = host.websocketEndpoints[0];
    assert.ok(url);
    const port = Number(new URL(url).port);
    const profile = {
      id: 'restart-host',
      name: 'Restart Host',
      kind: 'remote',
      transport: {
        kind: 'plaintext',
        url,
        acknowledgement: RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT,
      },
      rootId: capability.rootId,
    } as const;
    const connectRemote = (signal?: AbortSignal) =>
      connectRemoteRuntimeHostProfile({
        profile,
        credential,
        clientInstanceId: 'restart-client-instance',
        ...(signal ? { signal } : {}),
        connectTimeoutMs: 1_000,
        readyTimeoutMs: 5_000,
      });
    const initialRemote = await connectRemote();
    const firstHostEpoch = initialRemote.hostEpoch;
    const expected = await initialRemote.request('session.catalog.query', {
      kind: 'get',
      sessionId: 'session-before-restart',
    });
    remote = await createRuntimeHostReconnectingConnection({
      initialConnection: initialRemote,
      connect: connectRemote,
      backoff: { minMs: 10, maxMs: 25 },
    });

    await host.close();
    await Promise.all([initialRemote.closed, local.closed]);
    host = undefined;
    local = undefined;

    const recovered = remote.request(
      'session.catalog.query',
      { kind: 'get', sessionId: 'session-before-restart' },
      20_000,
    );
    host = await startExecutionRuntimeHostService({
      rootPath: root,
      websocket: { host: '127.0.0.1', port },
    });

    assert.deepEqual(await recovered, expected);
    assert.notEqual(remote.hostEpoch, firstHostEpoch);
  } finally {
    await Promise.allSettled([remote?.close(), local?.close()]);
    await host?.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('access credentials persist only as hashes and stay revoked after reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-'));
  try {
    const { consumeAccessCredentialDeliveryFromControlDirectory } = await import(
      '../control/access-credential-delivery.js'
    );
    const authority = await openRuntimeHostAccessAuthority(directory);
    const issued = await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'device-1',
      operationGrants: ['session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const credential = await consumeAccessCredentialDeliveryFromControlDirectory(
      directory,
      issued.deliveryId,
      issued.credentialId,
    );
    assert.equal(authority.authenticate(credential)?.principalId, 'device-1');
    assert.equal(authority.authenticate(credential)?.principalKind, 'remote_owner');
    await assert.rejects(
      authority.issue({
        principalKind: 'remote_owner',
        principalId: 'upgrader',
        operationGrants: ['host.upgrade.prepare'],
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
      }),
      /local-owner only/u,
    );
    await assert.rejects(
      authority.issue({
        principalKind: 'capability_provider',
        principalId: 'overprivileged-provider',
        operationGrants: ['session.catalog.query'],
        canPublishClientCapabilities: true,
        canUseHostPaths: false,
      }),
      /may grant only Client Capability publication/u,
    );
    assert.doesNotMatch(
      await readFile(join(directory, 'runtime-host-access.json'), 'utf8'),
      new RegExp(credential, 'u'),
    );

    const reopened = await openRuntimeHostAccessAuthority(directory);
    assert.equal(reopened.authenticate(credential)?.credentialId, issued.credentialId);
    assert.deepEqual(await reopened.revoke({ credentialId: issued.credentialId }), {
      credentialId: issued.credentialId,
      revoked: true,
    });
    assert.equal(reopened.authenticate(credential), undefined);
    assert.equal(
      (await openRuntimeHostAccessAuthority(directory)).authenticate(credential),
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps published credential state authoritative when directory sync is uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-unknown-commit-'));
  let failNextCommit = false;
  try {
    const { consumeAccessCredentialDeliveryFromControlDirectory } = await import(
      '../control/access-credential-delivery.js'
    );
    const authority = await openRuntimeHostAccessAuthority(directory, {
      writeFile: async (path, file) => {
        await writeAccessCredentialFile(path, file);
        if (!failNextCommit) return;
        failNextCommit = false;
        throw new RuntimeHostAccessCommitOutcomeUnknownError(new Error('directory sync failed'));
      },
    });
    const issued = await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'device-1',
      operationGrants: ['session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const credential = await consumeAccessCredentialDeliveryFromControlDirectory(
      directory,
      issued.deliveryId,
      issued.credentialId,
    );
    const revoked: string[] = [];
    authority.subscribeRevocations((credentialId) => revoked.push(credentialId));

    failNextCommit = true;
    await assert.rejects(
      authority.revoke({ credentialId: issued.credentialId }),
      RuntimeHostAccessCommitOutcomeUnknownError,
    );
    assert.equal(authority.authenticate(credential), undefined);
    assert.deepEqual(revoked, [issued.credentialId]);

    await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'device-2',
      operationGrants: ['session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    assert.equal(authority.authenticate(credential), undefined);
    assert.equal(
      (await openRuntimeHostAccessAuthority(directory)).authenticate(credential),
      undefined,
    );
    await authority.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired pairing candidates are denied and removed from durable access state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-expired-pairing-'));
  const credential = 'maka_rh_expired_pairing';
  const path = join(directory, 'runtime-host-access.json');
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [
          {
            credentialId: 'expired-pairing',
            credentialHash: createHash('sha256').update(credential).digest('hex'),
            principalId: 'expired-client',
            principalKind: 'remote_owner',
            status: 'pending',
            operationGrants: ['host.status', 'access.credential.finalize'],
            canPublishClientCapabilities: false,
            canUseHostPaths: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:05:00.000Z',
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const authority = await openRuntimeHostAccessAuthority(directory);
    assert.equal(authority.authenticate(credential), undefined);
    await waitForCondition(async () => {
      const file = JSON.parse(await readFile(path, 'utf8')) as { credentials?: unknown[] };
      return file.credentials?.length === 0;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('closed access authority cannot expire credentials owned by its successor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-close-'));
  const path = join(directory, 'runtime-host-access.json');
  const storedCredential = (
    credentialId: string,
    credential: string,
    status: 'pending' | 'active',
    expiresAt?: string,
  ) => ({
    credentialId,
    credentialHash: createHash('sha256').update(credential).digest('hex'),
    principalId: 'desktop-client',
    principalKind: 'remote_owner',
    status,
    operationGrants: ['host.status', 'access.credential.finalize'],
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
    createdAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
  });
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [
          storedCredential(
            'pending-credential',
            'maka_rh_pending',
            'pending',
            new Date(Date.now() + 100).toISOString(),
          ),
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const authority = await openRuntimeHostAccessAuthority(directory);
    await authority.close();
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [storedCredential('successor-credential', 'maka_rh_successor', 'active')],
      })}\n`,
      { mode: 0o600 },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const file = JSON.parse(await readFile(path, 'utf8')) as {
      credentials?: Array<{ credentialId?: string }>;
    };
    assert.deepEqual(
      file.credentials?.map((credential) => credential.credentialId),
      ['successor-credential'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps a formerly accepted local-only grant inert when opening an existing access file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-legacy-'));
  const credential = 'maka_rh_existing';
  try {
    await writeFile(
      join(directory, 'runtime-host-access.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [
          {
            credentialId: 'existing-upgrader',
            credentialHash: createHash('sha256').update(credential).digest('hex'),
            principalId: 'existing-client',
            principalKind: 'remote_owner',
            status: 'active',
            operationGrants: ['host.status', 'host.upgrade.prepare'],
            canPublishClientCapabilities: false,
            canUseHostPaths: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const authority = await openRuntimeHostAccessAuthority(directory);
    const connectionAuthority = authority.authenticate(credential);
    assert.ok(connectionAuthority);
    assert.deepEqual(connectionAuthority.operationGrants, ['host.status']);
    assert.equal(
      authorizeRuntimeHostOperation(connectionAuthority, {
        requestId: 'upgrade-request',
        operation: 'host.upgrade.prepare',
        input: {
          expectedHostEpoch: 'existing-host',
          allowInterruptActiveTasks: false,
        },
      } as RequestFrame),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('releases a retired operation grant when opening an existing access file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-retired-grant-'));
  const credential = 'maka_rh_existing_usage_client';
  try {
    await writeFile(
      join(directory, 'runtime-host-access.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [
          {
            credentialId: 'existing-usage-client',
            credentialHash: createHash('sha256').update(credential).digest('hex'),
            principalId: 'existing-usage-client',
            principalKind: 'remote_owner',
            status: 'active',
            // `oauth.account.usage.fetch` left the protocol with the retired
            // Claude subscription provider. A file issued before that must
            // still open — failing decode here kept the Host from starting —
            // with the unservable grant released rather than migrated.
            operationGrants: ['host.status', 'oauth.account.usage.fetch'],
            canPublishClientCapabilities: false,
            canUseHostPaths: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const authority = await openRuntimeHostAccessAuthority(directory);
    assert.deepEqual(authority.authenticate(credential)?.operationGrants, ['host.status']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates the released transcript query grant when opening an existing access file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-transcript-legacy-'));
  const credential = 'maka_rh_existing_transcript_client';
  try {
    await writeFile(
      join(directory, 'runtime-host-access.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [
          {
            credentialId: 'existing-transcript-client',
            credentialHash: createHash('sha256').update(credential).digest('hex'),
            principalId: 'existing-transcript-client',
            principalKind: 'remote_owner',
            status: 'active',
            operationGrants: ['host.status', 'session.transcript.query', 'session.transcript.page'],
            canPublishClientCapabilities: false,
            canUseHostPaths: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const authority = await openRuntimeHostAccessAuthority(directory);
    assert.deepEqual(authority.authenticate(credential)?.operationGrants, [
      'host.status',
      'session.transcript.page',
      'session.transcript.overlay.release',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adds bounded turn landmarks to an existing turn-query grant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-turn-landmarks-'));
  const credential = 'maka_rh_existing_turn_client';
  try {
    await writeFile(
      join(directory, 'runtime-host-access.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        credentials: [
          {
            credentialId: 'existing-turn-client',
            credentialHash: createHash('sha256').update(credential).digest('hex'),
            principalId: 'existing-turn-client',
            principalKind: 'remote_owner',
            status: 'active',
            operationGrants: ['host.status', 'session.turns.query'],
            canPublishClientCapabilities: false,
            canUseHostPaths: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const authority = await openRuntimeHostAccessAuthority(directory);
    assert.deepEqual(authority.authenticate(credential)?.operationGrants, [
      'host.status',
      'session.turns.query',
      'session.turn_landmarks.query',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a rejected required WebSocket listener releases Local IPC and root ownership', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-websocket-startup-rollback-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  try {
    await assert.rejects(
      startExecutionRuntimeHostService({
        rootPath: root,
        websocket: { host: '0.0.0.0', port: 0 },
      }),
      /must bind to loopback/u,
    );
    const successor = await startExecutionRuntimeHostService({ rootPath: root });
    await successor.close();
  } finally {
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

function requireConnection(
  result: Awaited<ReturnType<typeof connectRuntimeHost>>,
): RuntimeHostConnection {
  if (result.kind !== 'connected') throw new Error(`Local Client did not connect: ${result.kind}`);
  return result.connection;
}

async function waitForCondition(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true');
}
