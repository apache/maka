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

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeHostPeerNativeStream } from './peer-native.js';

const HEADER_BYTES = 13;
const CHUNK_BYTES = 64 * 1024;
const WINDOW_BYTES = 2 * 1024 * 1024;
const DATA = 1;
const ACK = 2;
const FIN = 3;
const PING = 4;
const PONG = 5;
const FIN_ACK = 6;
export const PEER_RECOVERY_TIMEOUT_MS = 30_000;

export interface PeerResumeState {
  readonly sessionId: string;
  readonly generation: number;
  readonly received: number;
}

export interface PeerStreamAttachment {
  readonly stream: RuntimeHostPeerNativeStream;
  readonly remainder: Buffer;
  readonly received: number;
}

export type ReconnectPeerStream = (
  state: PeerResumeState,
  signal: AbortSignal,
  upgrade: boolean,
) => Promise<PeerStreamAttachment | undefined>;

interface Path extends PeerStreamAttachment {
  sent: number;
  acknowledged: number;
  pong: number | undefined;
  ping: { id: number; started: number; sent: boolean } | undefined;
  finSent: boolean;
}

export class PeerResumeRejectedError extends Error {}

/** Process-local reliable byte stream. No Host request is interpreted or retried here. */
export class ResumablePeerStream implements RuntimeHostPeerNativeStream {
  readonly sessionId: string;
  readonly peerId: string;
  readonly closed: Promise<void>;
  readonly #lifetime = new AbortController();
  readonly #changed = new Set<() => void>();
  readonly #outgoing: { offset: number; bytes: Buffer }[] = [];
  readonly #incoming: Buffer[] = [];
  readonly #reconnect: ReconnectPeerStream | undefined;
  readonly #recoveryMs: number;
  readonly #heartbeatMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #timer: NodeJS.Timeout;
  #resolveClosed!: () => void;
  #generation = 0;
  #sent = 0;
  #acknowledged = 0;
  #received = 0;
  #consumed = 0;
  #path: Path | undefined;
  #lastPath: RuntimeHostPeerNativeStream['path'];
  #error: Error | undefined;
  #ended = false;
  #closing = false;
  #remoteFin = false;
  #reading = false;
  #writeTail: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #recovering = false;
  #recoveryStarted: number | undefined;
  #lastUpgrade = performance.now();
  #lastPing = performance.now();
  #pingId = 0;

  constructor(options: {
    peerId: string;
    sessionId?: string;
    reconnect?: ReconnectPeerStream;
    recoveryMs?: number;
    heartbeatMs?: number;
    heartbeatTimeoutMs?: number;
  }) {
    this.peerId = options.peerId;
    this.sessionId = options.sessionId ?? randomBytes(32).toString('hex');
    this.#reconnect = options.reconnect;
    this.#recoveryMs = options.recoveryMs ?? PEER_RECOVERY_TIMEOUT_MS;
    this.#heartbeatMs = options.heartbeatMs ?? 2_000;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 6_000;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#timer = setInterval(() => this.#tick(), Math.min(this.#heartbeatMs, 250));
    this.#timer.unref();
  }

  get path(): RuntimeHostPeerNativeStream['path'] {
    return this.#path?.stream.path ?? this.#lastPath;
  }
  get received(): number {
    return this.#consumed;
  }

  nextAttachment(): PeerResumeState {
    this.#assertOpen();
    return { sessionId: this.sessionId, generation: ++this.#generation, received: this.#consumed };
  }

  /** Reserve before awaiting authentication response: a delayed older attach cannot win. */
  reserve(state: PeerResumeState): void {
    this.#assertOpen();
    if (state.sessionId !== this.sessionId || state.generation <= this.#generation) {
      throw new PeerResumeRejectedError('Stale peer stream attachment');
    }
    this.#validateAcknowledgment(state.received);
    this.#generation = state.generation;
  }

  attach(generation: number, attachment: PeerStreamAttachment): void {
    try {
      this.#assertOpen();
      if (generation !== this.#generation || attachment.stream.peerId !== this.peerId) {
        throw new PeerResumeRejectedError('Peer stream attachment identity changed');
      }
      this.#acknowledge(attachment.received);
    } catch (error) {
      attachment.stream.abort();
      throw error;
    }
    const old = this.#path;
    const path: Path = {
      ...attachment,
      sent: this.#acknowledged,
      acknowledged: -1,
      pong: undefined,
      ping: undefined,
      finSent: false,
    };
    this.#path = path;
    this.#lastPath = path.stream.path;
    this.#recoveryStarted = undefined;
    old?.stream.abort();
    this.#notify();
    void this.#pumpRead(path).catch((error) => this.#pathFailed(path, error));
    void this.#pumpWrite(path).catch((error) => this.#pathFailed(path, error));
  }

  async read(): Promise<Buffer | null> {
    if (this.#reading) throw new Error('Concurrent peer stream read');
    this.#reading = true;
    try {
      while (true) {
        if (this.#error) throw this.#error;
        const bytes = this.#incoming.shift();
        if (bytes) {
          this.#consumed += bytes.length;
          this.#notify();
          return bytes;
        }
        if (this.#ended || this.#remoteFin) return null;
        await this.#wait();
      }
    } finally {
      this.#reading = false;
    }
  }

  write(bytes: Buffer): Promise<void> {
    if (this.#ended || this.#closing)
      return Promise.reject(this.#error ?? new Error('Peer stream closed'));
    // The caller already owns its frame; cap queued ownership as well as replay bytes.
    if (this.#queuedBytes + bytes.length > 4 * WINDOW_BYTES)
      return Promise.reject(new Error('Peer stream write queue full'));
    const owned = Buffer.from(bytes);
    this.#queuedBytes += owned.length;
    const task = this.#writeTail
      .then(async () => {
        for (let offset = 0; offset < owned.length; ) {
          this.#assertOpen();
          const size = Math.min(CHUNK_BYTES, owned.length - offset);
          if (this.#sent - this.#acknowledged + size > WINDOW_BYTES) {
            await this.#wait();
            continue;
          }
          const chunk = Buffer.from(owned.subarray(offset, offset + size));
          this.#outgoing.push({ offset: this.#sent, bytes: chunk });
          this.#sent += size;
          offset += size;
          this.#notify();
        }
        // Match socket write semantics: accepted into a bounded send window,
        // not one application frame per round trip. The replay owner retains
        // bytes until ACK; close waits for the entire window before FIN.
      })
      .finally(() => {
        this.#queuedBytes -= owned.length;
        this.#notify();
      });
    this.#writeTail = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    if (this.#ended) return;
    this.#closing = true;
    const timer = setTimeout(() => this.abort(), 5_000);
    try {
      await this.#writeTail;
      this.#notify();
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }

  abort(): void {
    this.#finish(new Error('Peer stream aborted'));
  }

  #assertOpen(): void {
    if (this.#ended)
      throw this.#error ?? new PeerResumeRejectedError('Peer stream no longer exists');
  }

  #validateAcknowledgment(offset: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > this.#sent ||
      (offset > this.#acknowledged &&
        offset !== this.#sent &&
        !this.#outgoing.some((chunk) => chunk.offset === offset))
    ) {
      throw new PeerResumeRejectedError('Invalid peer stream acknowledgment');
    }
  }

  #acknowledge(offset: number): void {
    this.#validateAcknowledgment(offset);
    if (offset <= this.#acknowledged) return;
    this.#acknowledged = offset;
    while (this.#outgoing[0] && this.#outgoing[0].offset + this.#outgoing[0].bytes.length <= offset)
      this.#outgoing.shift();
    this.#notify();
  }

  async #pumpRead(path: Path): Promise<void> {
    let buffered = path.remainder;
    while (this.#path === path && !this.#ended) {
      if (buffered.length < HEADER_BYTES) {
        const chunk = await path.stream.read();
        if (!chunk) throw new Error('Peer path ended');
        if (this.#path !== path) return;
        buffered = Buffer.concat([buffered, chunk]);
        continue;
      }
      const type = buffered[0];
      const wideOffset = buffered.readBigUInt64BE(1);
      const size = buffered.readUInt32BE(9);
      if (
        wideOffset > BigInt(Number.MAX_SAFE_INTEGER) ||
        size > CHUNK_BYTES ||
        (type !== DATA && size !== 0)
      ) {
        throw new PeerResumeRejectedError('Invalid peer stream frame');
      }
      if (buffered.length < HEADER_BYTES + size) {
        const chunk = await path.stream.read();
        if (!chunk) throw new Error('Peer path ended inside frame');
        if (this.#path !== path) return;
        buffered = Buffer.concat([buffered, chunk]);
        continue;
      }
      const offset = Number(wideOffset);
      const bytes = buffered.subarray(HEADER_BYTES, HEADER_BYTES + size);
      buffered = buffered.subarray(HEADER_BYTES + size);
      switch (type) {
        case DATA:
          if (size === 0 || this.#remoteFin)
            throw new PeerResumeRejectedError('Invalid peer stream data');
          if (offset + size <= this.#received) break; // Lost ACK: already retained/delivered.
          if (offset !== this.#received || this.#received - this.#consumed + size > WINDOW_BYTES)
            throw new PeerResumeRejectedError('Peer stream receive window violated');
          this.#incoming.push(Buffer.from(bytes));
          this.#received += size;
          break;
        case ACK:
          this.#acknowledge(offset);
          break;
        case PING:
          path.pong = offset;
          break;
        case PONG:
          if (path.ping?.id === offset) path.ping = undefined;
          break;
        case FIN:
          if (offset !== this.#received)
            throw new PeerResumeRejectedError('Peer stream close offset mismatch');
          this.#remoteFin = true;
          break;
        case FIN_ACK:
          if (!this.#closing || offset !== this.#sent)
            throw new PeerResumeRejectedError('Unexpected peer stream close acknowledgment');
          this.#finish();
          return;
        default:
          throw new PeerResumeRejectedError('Unknown peer stream frame');
      }
      this.#notify();
    }
  }

  async #pumpWrite(path: Path): Promise<void> {
    while (this.#path === path && !this.#ended) {
      if (this.#remoteFin) {
        try {
          await path.stream.write(frame(FIN_ACK, this.#received));
        } finally {
          // An explicit logical close is terminal even if its final ACK is lost.
          if (this.#path === path) this.#finish();
        }
        return;
      }
      // One fair pass per class: continuous inbound consumption must not
      // monopolize the writer with ACKs and starve PING/PONG or application data.
      let wroteControl = false;
      if (path.acknowledged !== this.#consumed) {
        path.acknowledged = this.#consumed;
        await path.stream.write(frame(ACK, path.acknowledged));
        wroteControl = true;
      }
      if (path.pong !== undefined) {
        const pong = path.pong;
        path.pong = undefined;
        await path.stream.write(frame(PONG, pong));
        wroteControl = true;
      }
      if (path.ping && !path.ping.sent) {
        path.ping.sent = true;
        await path.stream.write(frame(PING, path.ping.id));
        wroteControl = true;
      }
      if (this.#path !== path || this.#ended) return;
      const next = this.#outgoing.find((chunk) => chunk.offset >= path.sent);
      if (next) {
        await path.stream.write(frame(DATA, next.offset, next.bytes));
        path.sent = next.offset + next.bytes.length;
        continue;
      }
      if (
        this.#closing &&
        this.#queuedBytes === 0 &&
        this.#acknowledged === this.#sent &&
        !path.finSent
      ) {
        path.finSent = true;
        await path.stream.write(frame(FIN, this.#sent));
        continue;
      }
      if (!wroteControl) await this.#wait();
    }
  }

  #pathFailed(path: Path, error: unknown): void {
    if (this.#path !== path || this.#ended) return;
    if (error instanceof PeerResumeRejectedError) {
      this.#finish(error);
      return;
    }
    this.#path = undefined;
    path.stream.abort();
    this.#recoveryStarted ??= performance.now();
    this.#notify();
    void this.#recover(false);
  }

  #tick(): void {
    if (this.#ended) return;
    const now = performance.now();
    if (this.#recoveryStarted !== undefined && now - this.#recoveryStarted >= this.#recoveryMs) {
      this.#finish(new Error('Peer stream recovery deadline exceeded'));
      return;
    }
    const path = this.#path;
    if (!path) return;
    if (path.ping && now - path.ping.started >= this.#heartbeatTimeoutMs) {
      this.#pathFailed(path, new Error('Peer path round trip timed out'));
      return;
    }
    if (!path.ping && now - this.#lastPing >= this.#heartbeatMs) {
      this.#lastPing = now;
      path.ping = { id: ++this.#pingId, started: now, sent: false };
      this.#notify();
    }
    if (
      !this.#closing &&
      path.stream.path?.kind === 'transit' &&
      now - this.#lastUpgrade >= 5_000
    ) {
      this.#lastUpgrade = now;
      void this.#recover(true);
    }
  }

  async #recover(upgrade: boolean): Promise<void> {
    if (!this.#reconnect || this.#recovering || this.#ended) return;
    this.#recovering = true;
    const deadline = AbortSignal.timeout(upgrade ? 5_000 : this.#recoveryMs);
    const signal = AbortSignal.any([this.#lifetime.signal, deadline]);
    try {
      let attempt = 0;
      do {
        try {
          const state = this.nextAttachment();
          const attachment = await this.#reconnect(state, signal, upgrade);
          if (attachment) {
            if (signal.aborted || this.#ended) attachment.stream.abort();
            else this.attach(state.generation, attachment);
            return;
          }
        } catch (error) {
          if (error instanceof PeerResumeRejectedError) {
            // A failed optimization must not tear down an intact authorized
            // attachment. Once the old path is lost, rejection is terminal.
            if (!upgrade || !this.#path) this.#finish(error);
            return;
          }
          if (signal.aborted) return;
        }
        if (upgrade) return;
        await delay(
          Math.min(250 * 2 ** attempt++, 2_000) + Math.floor(Math.random() * 100),
          undefined,
          { signal },
        );
      } while (!this.#ended && !signal.aborted);
    } catch {
      /* cancellation belongs to the logical lifetime */
    } finally {
      this.#recovering = false;
      // A proactive dial may have overlapped failure of the old path.
      if (!this.#ended && !this.#path) void this.#recover(false);
    }
  }

  #finish(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    clearInterval(this.#timer);
    this.#lifetime.abort();
    this.#path?.stream.abort();
    this.#path = undefined;
    this.#outgoing.length = 0;
    if (error) this.#incoming.length = 0;
    this.#notify();
    this.#resolveClosed();
  }

  #wait(): Promise<void> {
    return new Promise((resolve) => this.#changed.add(resolve));
  }
  #notify(): void {
    for (const resolve of this.#changed) resolve();
    this.#changed.clear();
  }
}

function frame(type: number, offset: number, bytes: Buffer = Buffer.alloc(0)): Buffer {
  const packet = Buffer.allocUnsafe(HEADER_BYTES + bytes.length);
  packet[0] = type;
  packet.writeBigUInt64BE(BigInt(offset), 1);
  packet.writeUInt32BE(bytes.length, 9);
  bytes.copy(packet, HEADER_BYTES);
  return packet;
}
