import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveRootControlNamespace, resolveStorageRoot } from '@maka/storage/root-authority';
import {
  connectRemoteRuntimeHost,
  connectRuntimeHost,
  consumeAccessCredentialDelivery,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';
import {
  openRuntimeHostAccessAuthority,
  startExecutionRuntimeHostService,
} from '../server/index.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
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
    local = requireConnection(
      await connectRuntimeHost({ rootPath: root, surface: 'desktop', protocol: PROTOCOL }),
    );
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
        surface: 'tui',
        protocol: PROTOCOL,
      }),
      /must not contain credentials, a query, or a fragment/u,
    );

    const wrongRoot = await connectRemoteRuntimeHost({
      url,
      credential,
      expectedRootId: 'f'.repeat(64),
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      surface: 'tui',
      protocol: PROTOCOL,
    });
    assert.deepEqual(wrongRoot, { kind: 'unavailable', reason: 'root_mismatch' });

    const wrongComposition = await connectRemoteRuntimeHost({
      url,
      credential,
      expectedRootId: capability.rootId,
      compositionId: 'test.other',
      surface: 'tui',
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
      surface: 'tui',
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
    await assert.rejects(
      remote.request('project.catalog.query', { kind: 'list_start' }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );
    await assert.rejects(
      remote.request('project.catalog.mutate', {
        kind: 'select',
        projectId: 'project-1',
      }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'unauthorized',
    );

    const created = await local.request('session.create', {
      sessionId: 'shared-session',
      cwd: root,
      name: 'Shared Session',
      modelTarget: { kind: 'default' },
    });
    assert.ok(!('kind' in created));
    assert.deepEqual(
      await remote.request('session.catalog.query', {
        kind: 'get',
        sessionId: 'shared-session',
      }),
      { kind: 'session', session: created },
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
        ? { kind: 'session', session: renamed.session }
        : assert.fail('Remote Session rename did not commit'),
    );

    await assert.rejects(
      remote.request('session.create', {
        sessionId: 'remote-path-session',
        cwd: root,
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
      surface: 'capability-provider',
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

    assert.deepEqual(
      await local.request('access.credential.revoke', { credentialId: issued.credentialId }),
      { credentialId: issued.credentialId, revoked: true },
    );
    await remote.closed;
    remote = undefined;
    assert.deepEqual(
      await connectRemoteRuntimeHost({
        url,
        credential,
        expectedRootId: capability.rootId,
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        surface: 'tui',
        protocol: PROTOCOL,
      }),
      { kind: 'unavailable', reason: 'connect_failed' },
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
