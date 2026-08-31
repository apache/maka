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
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  decodeCollaborationInvitationCode,
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
  let guest: RuntimeHostConnection | undefined;
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
    const preparedGuest = await local.request('collaboration.invitation.prepare', {
      sessionId: 'shared-session',
      grantKinds: ['session_observation'],
    });
    const guestInvitation = decodeCollaborationInvitationCode(preparedGuest.invitationCode);
    const pendingGuest = await connectRemoteRuntimeHost({
      url,
      credential: guestInvitation.credential,
      clientInstanceId: 'guest-client',
      expectedRootId: capability.rootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: PROTOCOL,
    });
    assert.equal(pendingGuest.kind, 'connected', JSON.stringify(pendingGuest));
    if (pendingGuest.kind !== 'connected') assert.fail('Session Guest did not connect');
    await pendingGuest.connection.request('access.credential.finalize', {});
    await pendingGuest.connection.close();
    const activeGuest = await connectRemoteRuntimeHost({
      url,
      credential: guestInvitation.credential,
      clientInstanceId: 'guest-client',
      expectedRootId: capability.rootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: PROTOCOL,
    });
    assert.equal(activeGuest.kind, 'connected', JSON.stringify(activeGuest));
    if (activeGuest.kind !== 'connected') assert.fail('Session Guest did not reconnect');
    guest = activeGuest.connection;
    const sharedCatalog = await guest.request('session.shared.query', {});
    assert.equal(sharedCatalog.session?.id, 'shared-session');
    assert.equal('workspace' in sharedCatalog.session!, false);
    await assert.rejects(
      guest.request('session.catalog.query', { kind: 'list_start' }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    const guestSubscription = await guest.openSessionSubscription({
      sessionId: 'shared-session',
      transcript: { kind: 'none' },
    });
    const observationGrant = preparedGuest.grants.find(
      (grant) => grant.kind === 'session_observation',
    )!;
    const guestCatalogChanged = new Promise<string>((resolve) => {
      guest?.subscribeSessionCatalogChanges((frame) => resolve(frame.sessionId));
    });
    await local.request('collaboration.grant.revoke', {
      grantId: observationGrant.grantId,
    });
    assert.equal(await guestCatalogChanged, 'shared-session');
    const closed = await guestSubscription[Symbol.asyncIterator]().next();
    assert.equal(closed.done, false);
    assert.equal(closed.value?.kind, 'subscription.closed');
    if (closed.value?.kind === 'subscription.closed') {
      assert.equal(closed.value.reason, 'access_revoked');
    }
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
    assert.deepEqual(await remote.request('access.credential.finalize', {}), {
      reconnectRequired: false,
    });
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
        { reconnectRequired: false },
      );
      await remote.closed;
      remote = undefined;
      assert.deepEqual(
        await replacementConnection.connection.request('access.credential.finalize', {}),
        { reconnectRequired: false },
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
    await Promise.allSettled([guest?.close(), remote?.close(), local?.close()]);
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

test('capability-provider credentials retain a Host-verified Client owner identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-provider-owner-'));
  try {
    const authority = await openRuntimeHostAccessAuthority(directory);
    const owner = await authority.prepare({
      principalKind: 'remote_owner',
      principalId: 'terminal-owner',
      operationGrants: ['access.credential.finalize', 'session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
      bindClientInstance: true,
    });
    await authority.finalize(owner.credentialId, 'terminal-client', false);
    const unboundOwner = await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'unbound-owner',
      operationGrants: ['session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const providerInput = {
      principalKind: 'capability_provider' as const,
      principalId: 'terminal-mcp-provider',
      operationGrants: ['client.capability.replace', 'client.capability.unregister'] as const,
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
    };
    const expectedOwner = {
      principalId: 'terminal-owner',
      clientInstanceId: 'terminal-client',
    } as const;
    await assert.rejects(
      authority.issue({
        ...providerInput,
        capabilityOwnerCredentialId: unboundOwner.credentialId,
      }),
      /must be bound to one Client identity/u,
    );
    await assert.rejects(
      authority.issue({
        principalKind: 'remote_owner',
        principalId: 'invalid-owner-reference',
        operationGrants: ['session.catalog.query'],
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
        capabilityOwnerCredentialId: owner.credentialId,
      }),
      /Only a capability provider/u,
    );

    const provider = await authority.issue({
      ...providerInput,
      capabilityOwnerCredentialId: owner.credentialId,
    });
    assert.deepEqual(provider.capabilityOwner, expectedOwner);
    assert.equal(
      JSON.parse(await readFile(join(directory, 'runtime-host-access.json'), 'utf8')).schemaVersion,
      4,
    );
    const { consumeAccessCredentialDeliveryFromControlDirectory } = await import(
      '../control/access-credential-delivery.js'
    );
    const credential = await consumeAccessCredentialDeliveryFromControlDirectory(
      directory,
      provider.deliveryId,
      provider.credentialId,
    );
    assert.deepEqual(authority.authenticate(credential)?.capabilityOwner, expectedOwner);

    const replacementOwner = await authority.prepareRotation({
      replacementOfCredentialId: owner.credentialId,
    });
    await authority.finalize(replacementOwner.credentialId, 'terminal-client', false);
    const replacementProvider = await authority.issue({
      ...providerInput,
      principalId: 'rotated-terminal-mcp-provider',
      capabilityOwnerCredentialId: replacementOwner.credentialId,
    });
    assert.deepEqual(replacementProvider.capabilityOwner, provider.capabilityOwner);

    const reopened = await openRuntimeHostAccessAuthority(directory);
    assert.deepEqual(reopened.authenticate(credential)?.capabilityOwner, expectedOwner);
    await assert.rejects(
      reopened.issue({
        ...providerInput,
        principalId: 'missing-owner-provider',
        capabilityOwnerCredentialId: 'missing-owner-credential',
      }),
      /active remote-owner credential/u,
    );
    await authority.close();
    await reopened.close();
    const downgraded = JSON.parse(
      await readFile(join(directory, 'runtime-host-access.json'), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      join(directory, 'runtime-host-access.json'),
      `${JSON.stringify({ ...downgraded, schemaVersion: 3 })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      openRuntimeHostAccessAuthority(directory),
      /Pre-association Runtime Host access files cannot declare capability owners/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unbound WebSocket credential cannot claim an existing bound Client identity', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-bound-client-websocket-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const host = await startExecutionRuntimeHostService({
    rootPath: root,
    websocket: { host: '127.0.0.1', port: 0 },
  });
  let local: RuntimeHostConnection | undefined;
  let owner: RuntimeHostConnection | undefined;
  let provider: RuntimeHostConnection | undefined;
  try {
    local = requireConnection(await connectRuntimeHost({ rootPath: root, protocol: PROTOCOL }));
    const ownerCandidate = await local.request('access.credential.prepare', {
      principalKind: 'remote_owner',
      principalId: 'shared-owner',
      operationGrants: ['access.credential.finalize', 'session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
      bindClientInstance: true,
    });
    const ownerCredential = await consumeAccessCredentialDelivery(
      root,
      ownerCandidate.deliveryId,
      ownerCandidate.credentialId,
    );
    const url = host.websocketEndpoints[0]!;
    const pairing = requireRemoteConnection(
      await connectRemoteRuntimeHost({
        url,
        credential: ownerCredential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        clientInstanceId: 'client-a',
        protocol: PROTOCOL,
      }),
    );
    assert.deepEqual(await pairing.request('access.credential.finalize', {}), {
      reconnectRequired: true,
    });
    await pairing.close();
    owner = requireRemoteConnection(
      await connectRemoteRuntimeHost({
        url,
        credential: ownerCredential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        clientInstanceId: 'client-a',
        protocol: PROTOCOL,
      }),
    );
    const unbound = await local.request('access.credential.issue', {
      principalKind: 'remote_owner',
      principalId: 'shared-owner',
      operationGrants: ['session.catalog.query'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    const unboundCredential = await consumeAccessCredentialDelivery(
      root,
      unbound.deliveryId,
      unbound.credentialId,
    );
    const providerIssue = await local.request('access.credential.issue', {
      principalKind: 'capability_provider',
      principalId: 'shared-owner-provider',
      operationGrants: ['client.capability.replace', 'client.capability.unregister'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
      capabilityOwnerCredentialId: ownerCandidate.credentialId,
    });
    const providerCredential = await consumeAccessCredentialDelivery(
      root,
      providerIssue.deliveryId,
      providerIssue.credentialId,
    );
    provider = requireRemoteConnection(
      await connectRemoteRuntimeHost({
        url,
        credential: providerCredential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        clientInstanceId: 'provider-a',
        protocol: PROTOCOL,
      }),
    );
    await provider.replaceClientCapabilities({
      offers: () => [
        {
          offerId: 'bound-provider',
          version: '1',
          affinity: 'session',
          hostPathAccess: 'none',
          label: 'Bound provider',
          tools: [
            {
              serverId: 'bound-provider',
              name: 'echo',
              inputSchema: { type: 'object' },
            },
          ],
        },
      ],
      call: async () => ({ content: [{ type: 'text', text: 'bound' }] }),
    });

    assert.deepEqual(
      await connectRemoteRuntimeHost({
        url,
        credential: unboundCredential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        clientInstanceId: 'client-a',
        protocol: PROTOCOL,
      }),
      { kind: 'unavailable', reason: 'handshake_failed' },
    );
  } finally {
    await Promise.allSettled([provider?.close(), owner?.close(), local?.close()]);
    await host.close().catch(() => undefined);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('writes the capability-owner schema only after the association commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-owner-schema-'));
  let rejectAssociation = false;
  let authority: Awaited<ReturnType<typeof openRuntimeHostAccessAuthority>> | undefined;
  try {
    authority = await openRuntimeHostAccessAuthority(directory, {
      writeFile: async (path, file) => {
        if (rejectAssociation && file.schemaVersion === 4) {
          throw new Error('association write rejected');
        }
        await writeAccessCredentialFile(path, file);
      },
    });
    const owner = await authority.prepare({
      principalKind: 'remote_owner',
      principalId: 'schema-owner',
      operationGrants: ['access.credential.finalize'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
      bindClientInstance: true,
    });
    await authority.finalize(owner.credentialId, 'schema-client', false);
    const path = join(directory, 'runtime-host-access.json');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 3);

    const providerInput = {
      principalKind: 'capability_provider' as const,
      principalId: 'schema-provider',
      operationGrants: ['client.capability.replace', 'client.capability.unregister'] as const,
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
      capabilityOwnerCredentialId: owner.credentialId,
    };
    rejectAssociation = true;
    await assert.rejects(authority.issue(providerInput), /association write rejected/u);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 3);

    rejectAssociation = false;
    await authority.issue(providerInput);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 4);
  } finally {
    await authority?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('credential rotation preserves authority and cannot outlive its active source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-rotation-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const source = await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'desktop-client',
      operationGrants: ['access.credential.finalize', 'session.catalog.query'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
    });
    const replacement = await authority.prepareRotation({
      replacementOfCredentialId: source.credentialId,
    });
    assert.deepEqual(replacement.operationGrants, source.operationGrants);
    assert.equal(replacement.principalId, source.principalId);
    assert.equal(replacement.canPublishClientCapabilities, source.canPublishClientCapabilities);

    await authority.revoke({ credentialId: source.credentialId });
    await assert.rejects(
      authority.finalize(replacement.credentialId, 'rotation-client', false),
      /no longer active/u,
    );
    await assert.rejects(
      authority.prepareRotation({ replacementOfCredentialId: source.credentialId }),
      /no longer active/u,
    );
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Client-bound pairing candidate can be claimed by exactly one Client identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-client-claim-'));
  const root = join(directory, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
  const authority = await openRuntimeHostAccessAuthority(controlDirectory);
  try {
    const candidate = await authority.prepare({
      principalKind: 'remote_owner',
      principalId: 'desktop-owner:claim',
      operationGrants: ['access.credential.finalize', 'session.catalog.query'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
      bindClientInstance: true,
    });
    const credential = await consumeAccessCredentialDelivery(
      root,
      candidate.deliveryId,
      candidate.credentialId,
    );

    const pending = authority.authenticate(credential);
    assert.deepEqual(pending?.operationGrants, ['host.status', 'access.credential.finalize']);
    assert.equal(pending?.canPublishClientCapabilities, false);

    assert.deepEqual(await authority.finalize(candidate.credentialId, 'desktop-a', false), {
      reconnectRequired: true,
    });
    assert.deepEqual(await authority.finalize(candidate.credentialId, 'desktop-a', false), {
      reconnectRequired: true,
    });
    assert.deepEqual(await authority.finalize(candidate.credentialId, 'desktop-a', true), {
      reconnectRequired: false,
    });
    const claimed = authority.authenticate(credential);
    assert.equal(claimed?.clientInstanceId, 'desktop-a');
    assert.ok(
      claimed?.operationGrants !== 'all' &&
        claimed?.operationGrants.includes('session.catalog.query'),
    );
    await assert.rejects(
      authority.finalize(candidate.credentialId, 'desktop-b', true),
      /claimed by another Client/u,
    );
  } finally {
    await authority.close();
    await rm(controlDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('principal revocation is atomic with pairing finalization', async () => {
  const { consumeAccessCredentialDeliveryFromControlDirectory } = await import(
    '../control/access-credential-delivery.js'
  );
  for (const order of ['finalize-first', 'revoke-first'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `maka-access-principal-revoke-${order}-`));
    const authority = await openRuntimeHostAccessAuthority(directory);
    try {
      const principal = {
        principalKind: 'remote_owner' as const,
        principalId: 'desktop-owner:local-sharing',
      };
      const active = await authority.issue({
        ...principal,
        operationGrants: ['access.credential.finalize'],
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
      });
      const activeSecret = await consumeAccessCredentialDeliveryFromControlDirectory(
        directory,
        active.deliveryId,
        active.credentialId,
      );
      const candidate = await authority.prepare({
        ...principal,
        operationGrants: ['access.credential.finalize'],
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
        bindClientInstance: true,
      });
      const candidateSecret = await consumeAccessCredentialDeliveryFromControlDirectory(
        directory,
        candidate.deliveryId,
        candidate.credentialId,
      );

      if (order === 'finalize-first') {
        const finalized = authority.finalize(candidate.credentialId, 'desktop-new', false);
        const revoked = authority.revokePrincipal(principal);
        assert.deepEqual(await finalized, { reconnectRequired: true });
        assert.deepEqual(await revoked, { revoked: true });
      } else {
        const revoked = authority.revokePrincipal(principal);
        const finalized = authority.finalize(candidate.credentialId, 'desktop-new', false);
        assert.deepEqual(await revoked, { revoked: true });
        await assert.rejects(finalized, /no longer active/u);
      }

      assert.equal(authority.authenticate(activeSecret), undefined);
      assert.equal(authority.authenticate(candidateSecret), undefined);
      assert.deepEqual(await authority.revokePrincipal(principal), { revoked: false });
    } finally {
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('a revoked Client-bound credential remains readable after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-bound-revoke-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  const candidate = await authority.prepare({
    principalKind: 'remote_owner',
    principalId: 'desktop-owner:revoke',
    operationGrants: ['access.credential.finalize', 'session.catalog.query'],
    canPublishClientCapabilities: true,
    canUseHostPaths: false,
    bindClientInstance: true,
  });
  try {
    await authority.finalize(candidate.credentialId, 'desktop-a', false);
    await authority.revoke({ credentialId: candidate.credentialId });
  } finally {
    await authority.close();
  }

  const reopened = await openRuntimeHostAccessAuthority(directory);
  try {
    await reopened.issue({
      principalKind: 'remote_owner',
      principalId: 'desktop-owner:replacement',
      operationGrants: ['host.status'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('guarded credential revocation requires its active credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-access-authority-guarded-revoke-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const desktop = await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'desktop-client',
      operationGrants: ['access.credential.finalize'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
    });
    const target = await authority.issue({
      principalKind: 'remote_owner',
      principalId: 'other-client',
      operationGrants: ['access.credential.finalize'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });
    assert.deepEqual(
      await authority.revokeRotation({
        credentialId: 'already-absent',
        requiredActiveCredentialId: desktop.credentialId,
      }),
      { credentialId: 'already-absent', revoked: false },
    );
    await assert.rejects(
      authority.revokeRotation({
        credentialId: desktop.credentialId,
        requiredActiveCredentialId: desktop.credentialId,
      }),
      /cannot revoke itself/u,
    );
    await authority.revoke({ credentialId: desktop.credentialId });
    await assert.rejects(
      authority.revokeRotation({
        credentialId: target.credentialId,
        requiredActiveCredentialId: desktop.credentialId,
      }),
      /required credential is no longer active/u,
    );
  } finally {
    await authority.close();
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

function requireRemoteConnection(
  result: Awaited<ReturnType<typeof connectRemoteRuntimeHost>>,
): RuntimeHostConnection {
  if (result.kind !== 'connected') throw new Error(`Remote Client did not connect: ${result.kind}`);
  return result.connection;
}

async function waitForCondition(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true');
}
