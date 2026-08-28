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

test('authenticates three peers, consumes invitations once, and keeps authority state private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-'));
  const network = new MemoryPeerNetwork();
  const peers = ['peer-a', 'peer-b', 'peer-c'].map((peerId) => network.create(peerId));
  const nodes: PeerMeshNode[] = [];
  try {
    for (const [index, peer] of peers.entries()) {
      nodes.push(await openPeerMeshNode({ dataRoot: join(root, String(index)), peer }));
    }
    const [authority, memberB, memberC] = nodes as [PeerMeshNode, PeerMeshNode, PeerMeshNode];
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
    const current = authority.status()[0];
    assert.deepEqual(current?.roster.roster.members, ['peer-a', 'peer-b', 'peer-c']);
    assert.equal('authorityPrivateKey' in (current ?? {}), false);

    await authority.remove(mesh.roster.roster.meshId, 'peer-b');
    assert.deepEqual(authority.status()[0]?.roster.roster.members, ['peer-a', 'peer-c']);

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
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.routeHints, ['/memory/peer-c']);

    memberCPeer.setRouteHints(['/memory/peer-c-moved']);
    await memberC.reconcile();
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.routeHints, ['/memory/peer-c-moved']);

    await memberC.close();
    await serving[2];
    await rm(join(root, 'member-c'), { recursive: true, force: true });
    now += 6 * 60 * 1_000;
    authorityPeer.setRouteHints(['/memory/peer-a-moved']);
    await authority.reconcile();
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-a')?.routeHints, ['/memory/peer-a-moved']);

    memberCPeer.setRouteHints(['/memory/peer-c-rejoined']);
    memberC = await openPeerMeshNode({
      dataRoot: join(root, 'member-c'),
      peer: memberCPeer,
      now: () => now,
    });
    serving[2] = memberC.serve();
    await memberC.join(await authority.invite(mesh.roster.roster.meshId));
    assert.deepEqual(authority.resolveRoutes('peer-c')?.routeHints, ['/memory/peer-c-rejoined']);
    await memberB.reconcile();
    assert.deepEqual(memberB.resolveRoutes('peer-c')?.routeHints, ['/memory/peer-c-rejoined']);

    await authority.remove(mesh.roster.roster.meshId, 'peer-b');
    await memberC.reconcile();
    authorityPeer.setReachable(false);
    await memberB.reconcile();
    assert.deepEqual(memberB.status(), []);
    assert.equal(memberB.resolveRoutes('peer-c'), undefined);
    assert.deepEqual(memberC.status()[0]?.roster.roster.members, ['peer-a', 'peer-c']);
    assert.deepEqual(memberC.resolveRoutes('peer-a')?.routeHints, ['/memory/peer-a-moved']);

    await memberC.close();
    await serving[2];
    memberC = await openPeerMeshNode({
      dataRoot: join(root, 'member-c'),
      peer: memberCPeer,
      now: () => now,
    });
    assert.deepEqual(memberC.resolveRoutes('peer-a')?.routeHints, ['/memory/peer-a-moved']);
  } finally {
    await Promise.allSettled([authority.close(), memberB.close(), memberC.close()]);
    await Promise.allSettled(serving);
    await Promise.allSettled([authorityPeer.close(), memberBPeer.close(), memberCPeer.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshes its route after earlier peers consume the proof lifetime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-mesh-route-refresh-'));
  let now = Date.now();
  const network = new MemoryPeerNetwork(() => {
    now += 31_000;
  });
  const peers = Array.from({ length: 14 }, (_, index) =>
    network.create(`peer-${String.fromCharCode('a'.charCodeAt(0) + index)}`),
  );
  const nodes: PeerMeshNode[] = [];
  const serving: Promise<void>[] = [];
  try {
    for (const [index, peer] of peers.entries()) {
      const node = await openPeerMeshNode({
        dataRoot: join(root, String(index)),
        peer,
        now: () => now,
      });
      nodes.push(node);
      serving.push(node.serve());
    }
    const authority = nodes[0]!;
    const healthy = nodes[12]!;
    const mesh = await authority.create();
    for (const node of nodes.slice(1)) {
      await node.join(await authority.invite(mesh.roster.roster.meshId));
    }
    assert.equal(healthy.status()[0]?.roster.roster.revision, 13);

    for (const peer of peers.slice(1, 12)) peer.setReachable(false);
    await authority.reconcile();

    assert.equal(healthy.status()[0]?.roster.roster.revision, 14);
  } finally {
    await Promise.allSettled(nodes.map((node) => node.close()));
    await Promise.allSettled(serving);
    await Promise.allSettled(peers.map((peer) => peer.close()));
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
      await node.closeMesh(mesh.roster.roster.meshId);
    }
    assert.equal((await node.create()).roster.roster.closed, false);
    assert.equal(node.status().length, 16);
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

  constructor(private readonly onUnreachable?: () => void) {}

  create(peerId: string): MemoryPeerClient {
    const peer = new MemoryPeerClient(peerId, this.#peers, this.onUnreachable);
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
  #reachable = true;
  #routeHints: readonly string[];

  constructor(
    private readonly peerId: string,
    private readonly peers: ReadonlyMap<string, MemoryPeerClient>,
    private readonly onUnreachable?: () => void,
  ) {
    this.#routeHints = [`/memory/${peerId}`];
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

  signIdentity(payload: Buffer) {
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

  async connectMeshControl(input: {
    readonly peerId: string;
  }): Promise<RuntimeHostPeerNativeStream> {
    const remote = this.peers.get(input.peerId);
    if (!remote || !remote.#reachable) {
      this.onUnreachable?.();
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
    if (server) server.onStream(stream);
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
