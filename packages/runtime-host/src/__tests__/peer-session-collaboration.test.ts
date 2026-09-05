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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tcpConnect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { startRuntimeHostAuthenticatedListenerSet } from '../server/listener-set.js';
import { openRuntimeHostAccessAuthority } from '../server/access-authority.js';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/connection.js';
import { connectPeerRuntimeHost } from '../client/host-profile.js';
import type { RuntimeHostPeerClient } from '../client/peer-client.js';
import type { RuntimeHostPeerNativeStream } from '../transport/peer-native.js';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  decodeCollaborationInvitationCode,
  type SubscriptionFrame,
} from '../protocol/index.js';

test('production collaboration retains distinct Guest mounts, exact requests and subscriptions across lost replies and Host restart', {
  timeout: 60_000,
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-peer-collaboration-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const sockets = new Set<Socket>();
  const executions = new Map<string, number>();
  const guests: RuntimeHostConnection[] = [];
  const connections = new Set<RuntimeHostConnection>();
  let acceptStream: (stream: RuntimeHostPeerNativeStream) => void = (stream) => stream.abort();
  let host: RuntimeHostKernel | undefined;
  let local: RuntimeHostConnection | undefined;
  let dropCommittedReply = false;
  const disconnectPaths = () => {
    for (const socket of sockets) socket.destroy();
  };
  const wire = (socket: Socket, peerId: string): RuntimeHostPeerNativeStream => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const reader = socket[Symbol.asyncIterator]();
    return {
      peerId,
      path: { kind: 'direct', transport: 'tcp' },
      read: async () => {
        const next = await reader.next();
        return next.done ? null : Buffer.from(next.value);
      },
      write: (bytes) =>
        new Promise<void>((resolve, reject) => {
          socket.write(bytes, (error) => (error ? reject(error) : resolve()));
        }),
      close: async () => {
        socket.destroy();
      },
      abort: () => {
        socket.destroy();
      },
    };
  };
  const server = createServer((socket) => acceptStream(wire(socket, 'desktop')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const reachability = {
    lease: {
      version: 1 as const,
      peerId: 'host',
      revision: 1,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      directRoutes: [],
      coordinationRoutes: [],
    },
    publicKey: 'AA',
    signature: 'AA',
  };
  const peer = {
    identity: () => ({ peerId: 'host' }),
    observeAuthenticatedReachability: () => reachability,
    serveApplication: async (accept: typeof acceptStream, signal: AbortSignal) => {
      acceptStream = accept;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    connect: async () => {
      const socket = tcpConnect(address.port, '127.0.0.1');
      await once(socket, 'connect');
      return wire(socket, 'host');
    },
  } as unknown as RuntimeHostPeerClient;
  const connectGuest = async (credential: string) => {
    const connection = await connectPeerRuntimeHost({
      profileId: 'shared',
      transport: { kind: 'libp2p-direct', reachability },
      credential,
      expectedRootId: capability.rootId,
      clientInstanceId: 'desktop',
      peerClient: peer,
    });
    connections.add(connection);
    return connection;
  };
  const startHost = async (seed: boolean) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const sessionIds: string[] = [];
    if (seed) {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      for (let i = 0; i < 6; i++) {
        const session = await stores.sessionStore.create({
          cwd: root,
          llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          llmConnectionSlug: 'test-provider',
          model: 'test-model',
          permissionMode: 'explore',
        });
        sessionIds.push(session.id);
      }
    }
    const authority = await openRuntimeHostAccessAuthority(owner.controlDirectory);
    const createRequest = authority.createTurnAccessRequest.bind(authority);
    authority.createTurnAccessRequest = async (...args) => {
      const committed = await createRequest(...args);
      if (dropCommittedReply) {
        dropCommittedReply = false;
        disconnectPaths();
      }
      return committed;
    };
    host = await RuntimeHostKernel.start({
      owner,
      lifecycleMode: 'service',
      accessAuthority: authority,
      composition: defineInteractiveRuntimeHostComposition((context) =>
        createExecutionRuntimeHostComposition(
          context,
          {},
          {
            primaryBackendFactory: (backendContext) => {
              const backend = new FakeBackend(backendContext);
              const send = backend.send.bind(backend);
              backend.send = async function* (input) {
                executions.set(input.turnId, (executions.get(input.turnId) ?? 0) + 1);
                yield* send(input);
              };
              return backend;
            },
          },
        ),
      ),
      listenerSetFactory: (input) =>
        startRuntimeHostAuthenticatedListenerSet(input, {
          peer: {
            client: peer,
            reachability: { current: () => reachability } as never,
            accessAuthority: authority,
          },
        }),
    });
    const connected = await connectRuntimeHost({
      rootPath: root,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Owner did not connect');
    local = connected.connection;
    return sessionIds;
  };
  t.after(async () => {
    await Promise.allSettled([...connections].map((guest) => guest.close()));
    await local?.close();
    await host?.close();
    disconnectPaths();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  });
  const sessionIds = await startHost(true);
  const invitations = [];
  for (const sessionId of sessionIds) {
    const invitation = await local!.request('collaboration.invitation.prepare', {
      sessionId,
      grantKinds: ['session_observation', 'session_turn_request'],
    });
    invitations.push(invitation);
    const { credential } = decodeCollaborationInvitationCode(invitation.invitationCode);
    const pending = await connectGuest(credential);
    await pending.request('access.credential.finalize', {});
    // A dropped pending path can still be retained when the finalized Client
    // reconnects. Exercise that overlap, not only a fully retired predecessor.
    const guest = await connectGuest(credential);
    guests.push(guest);
    assert.equal((await guest.request('session.shared.query', {})).session?.id, sessionId);
    await pending.close();
  }
  assert.equal(host!.connectionCount, 7);
  const guest = guests[0]!;
  const connectionId = guest.connectionId;
  const subscription = await guest.openSessionSubscription({
    sessionId: sessionIds[0]!,
    transcript: { kind: 'none' },
  });
  const frames: SubscriptionFrame[] = [];
  const events = (async () => {
    for await (const frame of subscription) frames.push(frame);
  })();
  const intent = {
    sessionId: sessionIds[0]!,
    turnId: 'shared-turn',
    content: { text: 'hello collaboration' },
  };
  dropCommittedReply = true;
  const request = await guest.request('collaboration.turn-request.create', { intent }, 10_000);
  assert.equal(guest.connectionId, connectionId);
  assert.equal(
    (await guest.request('collaboration.turn-request.create', { intent })).requestId,
    request.requestId,
  );
  assert.equal((await guest.request('collaboration.turn-request.query', {})).requests.length, 1);
  assert.equal(
    (await guests[1]!.request('collaboration.turn-request.query', {})).requests.length,
    0,
  );
  await local!.request('collaboration.turn-request.decide', {
    requestId: request.requestId,
    decision: 'approve',
  });
  disconnectPaths();
  await until(async () => {
    const turn = await local!.request('turn.query', {
      sessionId: intent.sessionId,
      turnId: intent.turnId,
    });
    return turn.status === 'completed';
  });
  assert.equal(executions.get(intent.turnId), 1);
  await until(async () => frames.some((frame) => frame.kind === 'subscription.session_delta'));
  // Revoke while the observation's raw connection is gone: replay cannot
  // reopen the subscription or cross the current Session authority.
  disconnectPaths();
  await local!.request('collaboration.grant.revoke', {
    grantId: invitations[0]!.grants.find((grant) => grant.kind === 'session_observation')!.grantId,
  });
  await events;
  assert.ok(
    frames.some(
      (frame) => frame.kind === 'subscription.closed' && frame.reason === 'access_revoked',
    ),
  );
  await assert.rejects(
    guest.openSessionSubscription({ sessionId: intent.sessionId, transcript: { kind: 'none' } }),
  );
  await Promise.all(guests.map((connection) => connection.close()));
  guests.length = 0;
  await local!.close();
  local = undefined;
  const epoch = host!.hostEpoch;
  await host!.close();
  host = undefined;
  await startHost(false);
  assert.notEqual(host!.hostEpoch, epoch);
  const restored = await connectGuest(
    decodeCollaborationInvitationCode(invitations[0]!.invitationCode).credential,
  );
  guests.push(restored);
  const recovered = await restored.request('collaboration.turn-request.query', {});
  assert.equal(recovered.requests.length, 1);
  assert.equal(recovered.requests[0]!.requestId, request.requestId);
  assert.deepEqual(
    (
      await local!.request('collaboration.turn-request.decide', {
        requestId: request.requestId,
        decision: 'approve',
      })
    ).kind,
    'already_decided',
  );
  assert.equal(executions.get(intent.turnId), 1);
  const closed = restored.closed;
  await local!.request('collaboration.principal.revoke', {
    principalId: invitations[0]!.principalId,
  });
  await closed;
  await assert.rejects(
    connectGuest(decodeCollaborationInvitationCode(invitations[0]!.invitationCode).credential),
  );
});

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Collaboration projection did not converge');
}
