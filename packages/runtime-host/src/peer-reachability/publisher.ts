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

import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  authenticateSignedPeerReachabilityLease,
  canonicalPeerReachabilityLease,
  decodeSignedPeerReachabilityLease,
  isPeerReachabilityLeaseCurrent,
  PEER_REACHABILITY_LEASE_TTL_MS,
  PEER_REACHABILITY_REFRESH_LEAD_MS,
  peerReachabilityLeaseReceipt,
  peerReachabilityLeaseSigningBytes,
  samePeerReachabilityRoutes,
  verifySignedPeerReachabilityLease,
  type PeerReachabilityPeer,
  type PeerReachabilityLeaseReceipt,
  type SignedPeerReachabilityLeaseV1,
} from './model.js';

const STATE_FILE = 'peer-reachability.json';
const MAX_STATE_BYTES = 64 * 1_024;

export interface PeerReachabilityPublisher {
  current(): SignedPeerReachabilityLeaseV1;
  refresh(): Promise<SignedPeerReachabilityLeaseV1>;
  subscribe(listener: (lease: SignedPeerReachabilityLeaseV1) => void): () => void;
  close(): Promise<void>;
}

export async function openPeerReachabilityPublisher(input: {
  readonly dataRoot: string;
  readonly peer: PeerReachabilityPeer;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
}): Promise<PeerReachabilityPublisher> {
  await mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(input.dataRoot, 0o700);
  const now = input.now ?? Date.now;
  const monotonicNow = input.monotonicNow ?? performance.now.bind(performance);
  const current = await readState(join(input.dataRoot, STATE_FILE), input.peer);
  const publisher = new PeerReachabilityPublisherImpl(
    join(input.dataRoot, STATE_FILE),
    input.peer,
    now,
    monotonicNow,
    current,
  );
  await publisher.refresh();
  return publisher;
}

class PeerReachabilityPublisherImpl implements PeerReachabilityPublisher {
  #current: SignedPeerReachabilityLeaseV1 | undefined;
  #receipt: PeerReachabilityLeaseReceipt | undefined;
  #tail = Promise.resolve();
  #failure: Error | undefined;
  #closed = false;
  #closeTask: Promise<void> | undefined;
  readonly #listeners = new Set<(lease: SignedPeerReachabilityLeaseV1) => void>();

  constructor(
    private readonly path: string,
    private readonly peer: PeerReachabilityPeer,
    private readonly now: () => number,
    private readonly monotonicNow: () => number,
    current: SignedPeerReachabilityLeaseV1 | undefined,
  ) {
    this.#current = current;
    if (current) {
      this.#receipt = peerReachabilityLeaseReceipt({
        signed: current,
        wallNow: this.now(),
        monotonicNow: this.monotonicNow(),
      });
    }
  }

  current(): SignedPeerReachabilityLeaseV1 {
    this.#assertOpen();
    if (!this.#current) throw new Error('Peer reachability publisher is not initialized');
    return this.#current;
  }

  subscribe(listener: (lease: SignedPeerReachabilityLeaseV1) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<SignedPeerReachabilityLeaseV1> {
    this.#assertOpen();
    const task = this.#tail.then(async () => {
      this.#assertOpen();
      const identity = this.peer.identity();
      const reachability = this.peer.reachability();
      const now = this.now();
      const monotonicNow = this.monotonicNow();
      if (
        this.#current &&
        this.#current.lease.peerId === identity.peerId &&
        this.#current.lease.issuedAt <= now &&
        this.#current.lease.expiresAt > now + PEER_REACHABILITY_REFRESH_LEAD_MS &&
        isPeerReachabilityLeaseCurrent(
          this.#current,
          this.#receipt,
          monotonicNow + PEER_REACHABILITY_REFRESH_LEAD_MS,
        ) &&
        samePeerReachabilityRoutes(this.#current.lease, reachability)
      ) {
        return this.#current;
      }
      const revision = (this.#current?.lease.revision ?? 0) + 1;
      const lease = canonicalPeerReachabilityLease({
        version: 1,
        peerId: identity.peerId,
        revision,
        issuedAt: now,
        expiresAt: now + PEER_REACHABILITY_LEASE_TTL_MS,
        directRoutes: reachability.listenAddresses,
        coordinationRoutes: reachability.activeCoordinationRelays,
      });
      const identityProof = await this.peer.signIdentity(peerReachabilityLeaseSigningBytes(lease));
      const signed = decodeSignedPeerReachabilityLease({
        lease,
        publicKey: identityProof.publicKey.toString('base64url'),
        signature: identityProof.signature.toString('base64url'),
      });
      verifySignedPeerReachabilityLease({
        value: signed,
        expectedPeerId: identity.peerId,
        now,
        verifyIdentity: this.peer.verifyIdentity.bind(this.peer),
      });
      try {
        await writeState(this.path, signed);
        this.#adopt(signed, now, monotonicNow);
      } catch (error) {
        if (error instanceof PeerReachabilityPostCommitError) {
          this.#adopt(signed, now, monotonicNow);
          this.#notify(signed);
          this.#failure = error;
          throw error;
        }
        throw new PeerReachabilityPersistenceError(error);
      }
      this.#notify(signed);
      return signed;
    });
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    this.#listeners.clear();
  }

  #notify(lease: SignedPeerReachabilityLeaseV1): void {
    for (const listener of this.#listeners) {
      try {
        listener(lease);
      } catch {
        // Reachability publication remains authoritative even if an observer fails.
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Peer reachability publisher is closed');
    if (this.#failure) throw this.#failure;
  }

  #adopt(signed: SignedPeerReachabilityLeaseV1, wallNow: number, monotonicNow: number): void {
    this.#current = signed;
    this.#receipt = peerReachabilityLeaseReceipt({ signed, wallNow, monotonicNow });
  }
}

async function readState(
  path: string,
  peer: PeerReachabilityPeer,
): Promise<SignedPeerReachabilityLeaseV1 | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
      throw new Error('Invalid peer reachability state file');
    }
    const document = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('Invalid peer reachability state document');
    }
    const record = document as Record<string, unknown>;
    if (record.version !== 1 || Object.keys(record).length !== 2) {
      throw new Error('Invalid peer reachability state document');
    }
    return authenticateSignedPeerReachabilityLease({
      value: record.current,
      expectedPeerId: peer.identity().peerId,
      verifyIdentity: peer.verifyIdentity.bind(peer),
    });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function writeState(path: string, current: SignedPeerReachabilityLeaseV1): Promise<void> {
  const document = `${JSON.stringify({ version: 1, current }, null, 2)}\n`;
  if (Buffer.byteLength(document) > MAX_STATE_BYTES) {
    throw new Error('Peer reachability state is too large');
  }
  const temporary = `${path}.tmp`;
  let replaced = false;
  try {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(document, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path);
    replaced = true;
    try {
      await syncDirectory(dirname(path));
    } catch (error) {
      throw new PeerReachabilityPostCommitError(error);
    }
  } finally {
    if (!replaced) await unlink(temporary).catch(() => undefined);
  }
}

export class PeerReachabilityPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Peer reachability state could not be persisted', { cause });
  }
}

export class PeerReachabilityPostCommitError extends Error {
  constructor(cause: unknown) {
    super(
      'Peer reachability state was replaced but its durability could not be confirmed; reopen it',
      { cause },
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
