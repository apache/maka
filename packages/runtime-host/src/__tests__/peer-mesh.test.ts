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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { RuntimeHostPeerNativeStream } from '../transport/peer-native.js';
import {
  decodeSignedPeerMeshRoster,
  generatePeerMeshAuthorityKeyPair,
  peerMeshId,
  signPeerMeshRoster,
} from '../peer-mesh/model.js';
import { openPeerMeshNode, type PeerMeshNode, type PeerMeshTransport } from '../peer-mesh/node.js';
import {
  hasActivePeerMeshMembership,
  migrateLegacyPeerMeshState,
  PeerMeshPersistenceError,
  PeerMeshPostCommitError,
} from '../peer-mesh/store.js';
import { createPeerMeshOperationHandlers } from '../server/peer-mesh-authority.js';

test('preserves durable Mesh mutation outcomes and drains after an unknown commit', async () => {
  let drains = 0;
  const postCommit = createPeerMeshOperationHandlers(
    {
      create: () => Promise.reject(new PeerMeshPostCommitError(new Error('fsync failed'))),
    } as PeerMeshNode,
    { requestDrain: () => drains++ },
  );
  const created = await postCommit['peer.mesh.create']({}, undefined as never);
  assert.deepEqual(created, {
    ok: false,
    error: {
      code: 'commit_outcome_unknown',
      message: 'Peer Mesh changed, but its durable commit could not be confirmed',
    },
  });
  assert.equal(drains, 1);

  const persistence = createPeerMeshOperationHandlers({
    reconcile: () => Promise.reject(new PeerMeshPersistenceError(new Error('write failed'))),
  } as PeerMeshNode);
  const reconciled = await persistence['peer.mesh.reconcile']({}, undefined as never);
  assert.deepEqual(reconciled, {
    ok: false,
    error: {
      code: 'persistence_failed',
      message: 'Peer Mesh state could not be saved',
    },
  });
});

test('authenticates three peers, consumes invitations once, and keeps authority state private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-'));
  const network = new MemoryPeerNetwork();
  const peers = ['peer-a', 'peer-b', 'peer-c'].map((peerId) => network.create(peerId));
  const nodes: PeerMeshNode[] = [];
  try {
    for (const [index, peer] of peers.entries()) {
      nodes.push(
        await openPeerMeshNode({
          dataRoot: join(root, String(index)),
          peer,
          endpointKind: index === 0 ? 'client' : 'host',
        }),
      );
    }
    const [authority, memberB, memberC] = nodes as [PeerMeshNode, PeerMeshNode, PeerMeshNode];
    await authority.setDisplayName('Alice Desktop');
    const mesh = await authority.create();
    assert.deepEqual(mesh.authority.coordinationRelays, ['/memory/relay/peer-a']);
    const serving = authority.serve();

    const contested = await authority.invite(mesh.roster.roster.meshId);
    assert.deepEqual(contested.coordinationRelays, mesh.authority.coordinationRelays);
    const attempts = await Promise.allSettled([memberB.join(contested), memberC.join(contested)]);
    assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);

    const loser = attempts[0]?.status === 'rejected' ? memberB : memberC;
    await loser.join(await authority.invite(mesh.roster.roster.meshId));
    await memberB.setDisplayName('Build Host');
    await memberB.reconcile();
    await authority.setMeshDisplayName(mesh.roster.roster.meshId, 'Release Team');
    await memberB.reconcile();
    await authority.setMeshDisplayName(mesh.roster.roster.meshId, null);
    await memberB.reconcile();
    assert.equal(memberB.status()[0]?.roster.roster.displayName, undefined);
    await authority.setMeshDisplayName(mesh.roster.roster.meshId, 'Release Team');
    await memberB.reconcile();
    const current = authority.status()[0];
    assert.equal(memberB.status()[0]?.roster.roster.displayName, 'Release Team');
    assert.deepEqual(current?.roster.roster.members, ['peer-a', 'peer-b', 'peer-c']);
    assert.deepEqual(
      current?.memberRoutes.map(({ peerId, endpointKind, displayName }) => ({
        peerId,
        endpointKind,
        displayName,
      })),
      [
        { peerId: 'peer-a', endpointKind: 'client', displayName: 'Alice Desktop' },
        { peerId: 'peer-b', endpointKind: 'host', displayName: 'Build Host' },
        { peerId: 'peer-c', endpointKind: 'host', displayName: undefined },
      ],
    );
    assert.equal('authorityPrivateKey' in (current ?? {}), false);

    await authority.remove(mesh.roster.roster.meshId, 'peer-b');
    assert.deepEqual(authority.status()[0]?.roster.roster.members, ['peer-a', 'peer-c']);

    await memberC.leave(mesh.roster.roster.meshId);
    assert.deepEqual(memberC.status(), []);
    assert.deepEqual(authority.status()[0]?.roster.roster.members, ['peer-a']);

    const closing = authority.close();
    await assert.rejects(authority.invite(mesh.roster.roster.meshId), /closed/u);
    await closing;
    await peers[0]!.close();
    await serving;
  } finally {
    await Promise.allSettled(nodes.map((node) => node.close()));
    await Promise.allSettled(peers.map((peer) => peer.close()));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a modified authority-signed roster', () => {
  const keys = generatePeerMeshAuthorityKeyPair();
  const signed = signPeerMeshRoster(
    {
      version: 1,
      meshId: peerMeshId(keys.publicKey),
      revision: 1,
      members: ['peer-a'],
      closed: false,
    },
    keys,
  );
  assert.throws(() =>
    decodeSignedPeerMeshRoster({
      ...signed,
      roster: { ...signed.roster, members: ['peer-b'] },
    }),
  );
});

test('reconciles changed routes, propagates removal, and recovers the verified cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-routes-'));
  const network = new MemoryPeerNetwork();
  const authorityPeer = network.create('peer-a');
  const memberBPeer = network.create('peer-b');
  const memberCPeer = network.create('peer-c');
  let now = Date.now();
  const authority = await openPeerMeshNode({
    dataRoot: join(root, 'authority'),
    peer: authorityPeer,
    now: () => now,
  });
  const memberB = await openPeerMeshNode({
    dataRoot: join(root, 'member-b'),
    peer: memberBPeer,
    now: () => now,
  });
  let memberC = await openPeerMeshNode({
    dataRoot: join(root, 'member-c'),
    peer: memberCPeer,
    now: () => now,
  });
  const serving = [authority.serve(), memberB.serve(), memberC.serve()];
  try {
    const mesh = await authority.create();
    await memberB.join(await authority.invite(mesh.roster.roster.meshId));
    await memberC.join(await authority.invite(mesh.roster.roster.meshId));

    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.routeHints, ['/memory/peer-c/p2p/peer-c']);

    now += 6 * 60 * 1_000;
    await authority.reconcile();
    await memberC.setDisplayName('Peer C');
    await memberC.reconcile();
    authorityPeer.stallNextControl();
    await memberB.reconcile(AbortSignal.timeout(1_000));
    assert.deepEqual(memberB.resolveRoutes('peer-a')?.routeHints, ['/memory/peer-a/p2p/peer-a']);

    memberCPeer.setRouteHints(['/memory/peer-c-moved/p2p/peer-c']);
    await memberC.reconcile();
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.routeHints, [
      '/memory/peer-c-moved/p2p/peer-c',
    ]);

    await memberC.close();
    await serving[2];
    await rm(join(root, 'member-c'), { recursive: true, force: true });
    now += 6 * 60 * 1_000;
    authorityPeer.setRouteHints(['/memory/peer-a-moved/p2p/peer-a']);
    await authority.reconcile();
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-a')?.routeHints, [
      '/memory/peer-a-moved/p2p/peer-a',
    ]);

    memberCPeer.setRouteHints(['/memory/peer-c-rejoined/p2p/peer-c']);
    memberC = await openPeerMeshNode({
      dataRoot: join(root, 'member-c'),
      peer: memberCPeer,
      now: () => now,
    });
    serving[2] = memberC.serve();
    await memberC.join(await authority.invite(mesh.roster.roster.meshId));
    assert.deepEqual(authority.resolveRoutes('peer-c')?.routeHints, [
      '/memory/peer-c-rejoined/p2p/peer-c',
    ]);
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.routeHints, [
      '/memory/peer-c-rejoined/p2p/peer-c',
    ]);

    await authority.remove(mesh.roster.roster.meshId, 'peer-b');
    authorityPeer.setResponseDelay(25);
    await memberB.reconcile();
    assert.deepEqual(memberB.status(), []);
    authorityPeer.setResponseDelay(0);
    await memberC.reconcile();
    authorityPeer.setReachable(false);
    await memberB.reconcile();
    assert.equal(memberB.resolveRoutes('peer-c'), undefined);
    assert.deepEqual(memberC.status()[0]?.roster.roster.members, ['peer-a', 'peer-c']);
    assert.deepEqual(memberC.resolveRoutes('peer-a')?.routeHints, [
      '/memory/peer-a-moved/p2p/peer-a',
    ]);

    await memberC.close();
    await serving[2];
    memberC = await openPeerMeshNode({
      dataRoot: join(root, 'member-c'),
      peer: memberCPeer,
      now: () => now,
    });
    assert.deepEqual(memberC.resolveRoutes('peer-a')?.routeHints, [
      '/memory/peer-a-moved/p2p/peer-a',
    ]);
  } finally {
    await Promise.allSettled([authority.close(), memberB.close(), memberC.close()]);
    await Promise.allSettled(serving);
    await Promise.allSettled([authorityPeer.close(), memberBPeer.close(), memberCPeer.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('reconciles one selected Mesh into signed transit routes and native policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-transit-'));
  const network = new MemoryPeerNetwork();
  const authorityPeer = network.create('peer-a');
  const memberBPeer = network.create('peer-b');
  const memberCPeer = network.create('peer-c');
  const memberDPeer = network.create('peer-d');
  const authority = await openPeerMeshNode({ dataRoot: join(root, 'a'), peer: authorityPeer });
  const memberB = await openPeerMeshNode({ dataRoot: join(root, 'b'), peer: memberBPeer });
  const memberC = await openPeerMeshNode({ dataRoot: join(root, 'c'), peer: memberCPeer });
  const memberD = await openPeerMeshNode({ dataRoot: join(root, 'd'), peer: memberDPeer });
  const serving = [authority.serve(), memberB.serve(), memberC.serve(), memberD.serve()];
  try {
    const meshId = (await authority.create()).roster.roster.meshId;
    await memberB.join(await authority.invite(meshId));
    await memberC.join(await authority.invite(meshId));
    await memberD.join(await authority.invite(meshId));

    authorityPeer.failNextTransitConfiguration();
    await authority.setTransitMesh(meshId);
    await authority.reconcile();
    await memberB.reconcile();
    assert.equal(authority.transitMeshId(), meshId);
    assert.deepEqual(authorityPeer.transitPolicy.allowedPeerIds, ['peer-b', 'peer-c', 'peer-d']);
    assert.deepEqual(memberBPeer.transitPolicy.relayCandidates, [
      {
        peerId: 'peer-a',
        addresses: ['/memory/peer-a/p2p/peer-a'],
        coordinationRelays: ['/memory/relay/peer-a'],
      },
    ]);
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.transitRelayPeerIds, ['peer-a']);

    await memberD.setTransitMesh(meshId);
    await memberD.reconcile();
    memberDPeer.setRouteHints(['/memory/peer-c/p2p/peer-c']);
    await memberD.reconcile();
    await memberB.reconcile();
    assert.deepEqual(memberBPeer.transitPolicy.relayCandidates, [
      {
        peerId: 'peer-a',
        addresses: ['/memory/peer-a/p2p/peer-a'],
        coordinationRelays: ['/memory/relay/peer-a'],
      },
      {
        peerId: 'peer-d',
        addresses: [],
        coordinationRelays: ['/memory/relay/peer-d'],
      },
    ]);
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.transitRelayPeerIds, ['peer-a', 'peer-d']);
    const secondMeshId = (await memberB.create()).roster.roster.meshId;
    await memberD.join(await memberB.invite(secondMeshId));
    await authority.remove(meshId, 'peer-d');
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.transitRelayPeerIds, ['peer-a']);

    await authority.remove(meshId, 'peer-b');
    assert.deepEqual(authorityPeer.transitPolicy.allowedPeerIds, ['peer-c']);
    await memberB.reconcile();
    assert.deepEqual(memberBPeer.transitPolicy, {
      allowedPeerIds: [],
      relayCandidates: [],
    });

    await authority.closeMesh(meshId);
    assert.deepEqual(authority.status(), []);
    assert.equal(authority.transitMeshId(), null);
    assert.deepEqual(authorityPeer.transitPolicy.allowedPeerIds, []);
  } finally {
    await Promise.allSettled([
      authority.close(),
      memberB.close(),
      memberC.close(),
      memberD.close(),
    ]);
    await Promise.allSettled([
      ...serving,
      authorityPeer.close(),
      memberBPeer.close(),
      memberCPeer.close(),
      memberDPeer.close(),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test('closed Mesh records do not permanently consume membership capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-capacity-'));
  const peer = new MemoryPeerNetwork().create('peer-a');
  const node = await openPeerMeshNode({ dataRoot: root, peer });
  try {
    for (let index = 0; index < 16; index += 1) {
      const mesh = await node.create();
      if (index === 0) assert.equal(await hasActivePeerMeshMembership(root, 'peer-a'), true);
      await node.closeMesh(mesh.roster.roster.meshId);
      if (index === 0) assert.equal(await hasActivePeerMeshMembership(root, 'peer-a'), false);
    }
    assert.equal((await node.create()).roster.roster.closed, false);
    assert.equal(node.status().length, 1);
  } finally {
    await node.close();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('persists the endpoint name and selected transit Mesh together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-presentation-'));
  const peer = new MemoryPeerNetwork().create('peer-a');
  let node = await openPeerMeshNode({ dataRoot: root, peer });
  try {
    const meshId = (await node.create()).roster.roster.meshId;
    peer.failNextSignature();
    await assert.rejects(node.setDisplayName('Rejected alias'), /identity signing failed/u);
    assert.equal(node.displayName(), undefined);
    await node.setDisplayName('Alice Host');
    await node.setTransitMesh(meshId);
    await node.close();

    node = await openPeerMeshNode({ dataRoot: root, peer });
    assert.equal(node.displayName(), 'Alice Host');
    assert.equal(node.transitMeshId(), meshId);
  } finally {
    await node.close();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates legacy Mesh state into the peer identity root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-migration-'));
  const peer = new MemoryPeerNetwork().create('peer-a');
  let node = await openPeerMeshNode({ dataRoot: root, peer });
  try {
    const created = await node.create();
    await node.close();
    await migrateLegacyPeerMeshState(root, 'peer-a');
    node = await openPeerMeshNode({ dataRoot: join(root, 'peer-a'), peer });
    assert.equal(node.status()[0]?.roster.roster.meshId, created.roster.roster.meshId);
  } finally {
    await node.close();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retries a committed invitation redemption for the same authenticated peer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-retry-'));
  const network = new MemoryPeerNetwork();
  const authorityPeer = network.create('peer-a');
  const memberPeer = network.create('peer-b');
  const authorityRoot = join(root, 'authority');
  let now = Date.now();
  let authority = await openPeerMeshNode({
    dataRoot: authorityRoot,
    peer: authorityPeer,
    now: () => now,
  });
  const member = await openPeerMeshNode({ dataRoot: join(root, 'member'), peer: memberPeer });
  let serving = authority.serve();
  try {
    const mesh = await authority.create();
    const invitation = await authority.invite(mesh.roster.roster.meshId, { ttlMs: 1_000 });
    authorityPeer.failNextResponse();

    await assert.rejects(member.join(invitation));
    await authority.close();
    await serving;

    now += 2_000;
    await assert.rejects(
      openPeerMeshNode({ dataRoot: authorityRoot, peer: memberPeer }),
      /different peer identity/u,
    );
    authority = await openPeerMeshNode({
      dataRoot: authorityRoot,
      peer: authorityPeer,
      now: () => now,
    });
    serving = authority.serve();
    const joined = await member.join(invitation);
    assert.deepEqual(joined.roster.roster.members, ['peer-a', 'peer-b']);
    assert.equal(joined.roster.roster.closed, false);
    await member.reconcile();
    assert.equal(authority.status()[0]?.roster.roster.revision, 2);

    await authority.close();
    await authorityPeer.close();
    await serving;
  } finally {
    await Promise.allSettled([authority.close(), member.close()]);
    await Promise.allSettled([authorityPeer.close(), memberPeer.close()]);
    await Promise.allSettled([serving]);
    await rm(root, { recursive: true, force: true });
  }
});

test('cancels a redemption stalled after the control connection opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-abort-'));
  const network = new MemoryPeerNetwork();
  const authorityPeer = network.create('peer-a');
  const memberPeer = network.create('peer-b');
  const authority = await openPeerMeshNode({
    dataRoot: join(root, 'authority'),
    peer: authorityPeer,
  });
  const member = await openPeerMeshNode({ dataRoot: join(root, 'member'), peer: memberPeer });
  const serving = authority.serve();
  try {
    const mesh = await authority.create();
    const invitation = await authority.invite(mesh.roster.roster.meshId);
    authorityPeer.stallNextControl();
    const abort = new AbortController();
    const joining = member.join(invitation, abort.signal);
    await waitForImmediate();
    abort.abort();
    await assert.rejects(
      joining,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.deepEqual(authority.status()[0]?.roster.roster.members, ['peer-a']);
  } finally {
    await Promise.allSettled([authority.close(), member.close()]);
    await Promise.allSettled([authorityPeer.close(), memberPeer.close(), serving]);
    await rm(root, { recursive: true, force: true });
  }
});

class MemoryPeerNetwork {
  readonly #peers = new Map<string, MemoryPeerClient>();

  create(peerId: string): MemoryPeerClient {
    const peer = new MemoryPeerClient(peerId, this.#peers);
    this.#peers.set(peerId, peer);
    return peer;
  }
}

class MemoryPeerClient implements PeerMeshTransport {
  #meshServer:
    | {
        readonly onStream: (stream: RuntimeHostPeerNativeStream) => void;
        readonly stop: () => void;
      }
    | undefined;
  #closed = false;
  #failNextResponse = false;
  #stallNextControl = false;
  #responseDelayMs = 0;
  #reachable = true;
  #routeHints: readonly string[];
  transitPolicy = {
    allowedPeerIds: [] as readonly string[],
    relayCandidates: [] as readonly {
      readonly peerId: string;
      readonly addresses: readonly string[];
      readonly coordinationRelays: readonly string[];
    }[],
  };
  #failNextTransitConfiguration = false;
  #failNextSignature = false;

  constructor(
    private readonly peerId: string,
    private readonly peers: ReadonlyMap<string, MemoryPeerClient>,
  ) {
    this.#routeHints = [`/memory/${peerId}/p2p/${peerId}`];
  }

  identity() {
    return {
      peerId: this.peerId,
      listenAddresses: this.#routeHints,
      coordinationRelays: [`/memory/relay/${this.peerId}`],
    } as const;
  }

  setRouteHints(routeHints: readonly string[]): void {
    this.#routeHints = [...routeHints];
  }

  setReachable(reachable: boolean): void {
    this.#reachable = reachable;
  }

  setResponseDelay(delayMs: number): void {
    this.#responseDelayMs = delayMs;
  }

  failNextTransitConfiguration(): void {
    this.#failNextTransitConfiguration = true;
  }

  failNextSignature(): void {
    this.#failNextSignature = true;
  }

  signIdentity(payload: Buffer) {
    if (this.#failNextSignature) {
      this.#failNextSignature = false;
      return Promise.reject(new Error('identity signing failed'));
    }
    return Promise.resolve({
      publicKey: Buffer.from(this.peerId),
      signature: memorySignature(this.peerId, payload),
    });
  }

  verifyIdentity(
    peerId: string,
    payload: Buffer,
    proof: { readonly publicKey: Buffer; readonly signature: Buffer },
  ): boolean {
    return (
      proof.publicKey.toString() === peerId &&
      proof.signature.equals(memorySignature(peerId, payload))
    );
  }

  transitSnapshot() {
    return {
      allowedPeerCount: this.transitPolicy.allowedPeerIds.length,
      activeReservationCount: 0,
      activeCircuitCount: 0,
      maxReservationCount: 32,
      maxCircuitCount: 8,
      maxCircuitsPerPeer: 2,
      maxCircuitDurationSeconds: 7_200,
      maxCircuitBytes: 256 * 1024 * 1024,
    };
  }

  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
    readonly relayCandidates: readonly {
      readonly peerId: string;
      readonly addresses: readonly string[];
      readonly coordinationRelays: readonly string[];
    }[];
  }): Promise<void> {
    if (this.#failNextTransitConfiguration) {
      this.#failNextTransitConfiguration = false;
      return Promise.reject(new Error('Injected transit configuration failure'));
    }
    this.transitPolicy = {
      allowedPeerIds: [...input.allowedPeerIds],
      relayCandidates: input.relayCandidates.map(({ peerId, addresses, coordinationRelays }) => ({
        peerId,
        addresses: [...addresses],
        coordinationRelays: [...coordinationRelays],
      })),
    };
    return Promise.resolve();
  }

  async connectMeshControl(input: {
    readonly peerId: string;
  }): Promise<RuntimeHostPeerNativeStream> {
    const remote = this.peers.get(input.peerId);
    if (!remote || !remote.#reachable) {
      throw new Error('Peer is unavailable');
    }
    const [localStream, remoteStream] = memoryStreamPair(this.peerId, input.peerId);
    if (remote.#failNextResponse) {
      remote.#failNextResponse = false;
      remoteStream.failNextWrite();
    }
    remote.accept(remoteStream);
    return localStream;
  }

  failNextResponse(): void {
    this.#failNextResponse = true;
  }

  stallNextControl(): void {
    this.#stallNextControl = true;
  }

  serveMeshControl(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#meshServer) return Promise.reject(new Error('Mesh control is already served'));
    signal.throwIfAborted();
    return new Promise<void>((resolve) => {
      const stop = () => {
        if (this.#meshServer?.stop === stop) this.#meshServer = undefined;
        signal.removeEventListener('abort', stop);
        resolve();
      };
      this.#meshServer = { onStream, stop };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.#meshServer?.stop();
    return Promise.resolve();
  }

  accept(stream: RuntimeHostPeerNativeStream): void {
    if (this.#stallNextControl) {
      this.#stallNextControl = false;
      return;
    }
    const server = this.#meshServer;
    if (server && this.#responseDelayMs > 0) {
      setTimeout(() => server.onStream(stream), this.#responseDelayMs);
    } else if (server) server.onStream(stream);
    else stream.abort();
  }
}

function memorySignature(peerId: string, payload: Buffer): Buffer {
  return createHash('sha256').update(peerId).update(payload).digest();
}

function memoryStreamPair(localPeerId: string, remotePeerId: string): [MemoryStream, MemoryStream] {
  const local = new MemoryStream(remotePeerId);
  const remote = new MemoryStream(localPeerId);
  local.connect(remote);
  remote.connect(local);
  return [local, remote];
}

class MemoryStream implements RuntimeHostPeerNativeStream {
  readonly #incoming: Array<Buffer | null> = [];
  readonly #waiters: Array<(chunk: Buffer | null) => void> = [];
  #remote: MemoryStream | undefined;
  #closed = false;
  #failNextWrite = false;

  constructor(readonly peerId: string) {}

  connect(remote: MemoryStream): void {
    this.#remote = remote;
  }

  read(): Promise<Buffer | null> {
    const chunk = this.#incoming.shift();
    if (chunk !== undefined) return Promise.resolve(chunk);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async write(bytes: Buffer): Promise<void> {
    if (this.#closed || !this.#remote) throw new Error('Stream is closed');
    if (this.#failNextWrite) {
      this.#failNextWrite = false;
      throw new Error('Simulated response loss');
    }
    this.#remote.push(Buffer.from(bytes));
  }

  failNextWrite(): void {
    this.#failNextWrite = true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#remote?.push(null);
  }

  abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.push(null);
    this.#remote?.push(null);
  }

  push(chunk: Buffer | null): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(chunk);
    else this.#incoming.push(chunk);
  }
}
