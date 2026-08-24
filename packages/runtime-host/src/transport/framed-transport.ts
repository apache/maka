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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import type { Socket } from 'node:net';
import { RUNTIME_HOST_MAX_MESSAGE_BYTES, type EncodedProtocolMessage } from '../protocol/index.js';
import { frameLocalIpcProtocolMessage, LocalIpcProtocolFrameDecoder } from './local-ipc-framing.js';
import type { RuntimeHostMessageTransport } from './message-transport.js';

const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

interface QueuedFrame {
  value: unknown;
  encodedBytes: number;
}

interface ReadWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export class RuntimeHostTransportError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'read_eof'
      | 'read_timeout'
      | 'concurrent_read'
      | 'inbound_queue_full'
      | 'outbound_queue_full',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostTransportError';
  }
}

export class FramedTransport implements RuntimeHostMessageTransport {
  readonly closed: Promise<void>;
  readonly #decoder = new LocalIpcProtocolFrameDecoder();
  readonly #queue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #buffered = Buffer.alloc(0);
  #waiter: ReadWaiter | undefined;
  #failure: Error | undefined;
  #readTerminal: RuntimeHostTransportError | undefined;
  #ended = false;
  #decoderEnded = false;
  #paused = false;
  #resolveClosed!: () => void;

  constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on('data', (chunk) =>
      this.#receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
    );
    socket.once('end', () => {
      this.#ended = true;
      this.#drainInbound();
    });
    socket.once('error', (error) => this.#fail(transportFailure(error)));
    socket.once('close', (hadError) => {
      if (!this.#readTerminal || hadError) {
        this.#fail(new RuntimeHostTransportError('closed', 'Runtime Host transport closed'));
      }
      this.#resolveClosed();
    });
  }

  async read(timeoutMs: number): Promise<unknown> {
    const queued = this.#queue.shift();
    if (queued) {
      this.#queuedBytes -= queued.encodedBytes;
      this.#drainInbound();
      return queued.value;
    }
    if (this.#failure) throw this.#failure;
    if (this.#readTerminal) throw this.#readTerminal;
    if (this.#waiter) {
      throw new RuntimeHostTransportError(
        'concurrent_read',
        'Only one Runtime Host frame read may be pending',
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadWaiter = { resolve, reject };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (this.#waiter !== waiter) return;
          const error = new RuntimeHostTransportError(
            'read_timeout',
            'Timed out waiting for Runtime Host frame',
          );
          this.#fail(error);
          this.socket.destroy();
        }, timeoutMs);
      }
      this.#waiter = waiter;
      this.#drainInbound();
    });
  }

  write(message: EncodedProtocolMessage): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    const frame = frameLocalIpcProtocolMessage(message);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => {
        if (!error) {
          resolve();
          return;
        }
        const failure = transportFailure(error);
        this.#fail(failure);
        reject(failure);
      });
    });
  }

  closeAfterFlush(): void {
    this.socket.destroySoon();
  }

  abort(error?: Error): void {
    if (error) this.#fail(error);
    this.socket.destroy(error);
  }

  #receive(chunk: Buffer): void {
    if (this.#failure) return;
    if (this.#buffered.byteLength + chunk.byteLength > MAX_BUFFERED_BYTES) {
      this.#failInboundOverflow();
      return;
    }
    this.#buffered =
      this.#buffered.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffered, chunk]);
    this.#drainInbound();
  }

  #drainInbound(): void {
    if (this.#failure) return;
    try {
      while (true) {
        const newline = this.#buffered.indexOf(0x0a);
        if (newline === -1) {
          if (this.#buffered.byteLength > RUNTIME_HOST_MAX_MESSAGE_BYTES) {
            throw new RuntimeHostProtocolError(
              'frame_too_large',
              'Runtime Host message exceeds the byte limit',
            );
          }
          break;
        }
        const encodedBytes = newline + 1;
        if (
          !this.#waiter &&
          (this.#queue.length >= MAX_QUEUED_FRAMES ||
            this.#queuedBytes + encodedBytes > MAX_QUEUED_BYTES)
        ) {
          break;
        }
        const encoded = this.#buffered.subarray(0, encodedBytes);
        this.#buffered = this.#buffered.subarray(encodedBytes);
        const frames = this.#decoder.push(encoded);
        if (frames.length !== 1) {
          throw new Error('Runtime Host decoder did not produce one complete frame');
        }
        this.#deliver(frames[0], encodedBytes);
      }
      if (this.#ended && !this.#decoderEnded && this.#buffered.indexOf(0x0a) === -1) {
        if (this.#buffered.byteLength !== 0) {
          this.#decoder.push(this.#buffered);
          this.#buffered = Buffer.alloc(0);
        }
        this.#decoder.end();
        this.#decoderEnded = true;
        this.#endRead();
      }
    } catch (error) {
      this.#fail(asError(error));
      this.socket.destroy();
      return;
    }
    this.#updateReadFlow();
  }

  #deliver(frame: unknown, encodedBytes: number): void {
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.#queue.push({ value: frame, encodedBytes });
      this.#queuedBytes += encodedBytes;
    }
  }

  #updateReadFlow(): void {
    const nextNewline = this.#buffered.indexOf(0x0a);
    const nextFrameBytes = nextNewline === -1 ? undefined : nextNewline + 1;
    const blocked =
      this.#queue.length >= MAX_QUEUED_FRAMES ||
      (nextFrameBytes !== undefined && this.#queuedBytes + nextFrameBytes > MAX_QUEUED_BYTES);
    if (blocked && !this.#paused) {
      this.#paused = true;
      this.socket.pause();
      return;
    }
    if (!blocked && this.#paused && !this.#ended) {
      this.#paused = false;
      this.socket.resume();
    }
  }

  #failInboundOverflow(): void {
    this.#fail(
      new RuntimeHostTransportError(
        'inbound_queue_full',
        'Runtime Host inbound byte buffer is full',
      ),
    );
    this.socket.destroy();
  }

  #endRead(): void {
    if (this.#readTerminal || this.#failure) return;
    this.#readTerminal = new RuntimeHostTransportError(
      'read_eof',
      'Runtime Host transport read side ended',
    );
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(this.#readTerminal);
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new RuntimeHostProtocolError('invalid_frame', String(error));
}

function transportFailure(error: Error): Error {
  if (error instanceof RuntimeHostTransportError || error instanceof RuntimeHostProtocolError) {
    return error;
  }
  return new RuntimeHostTransportError(
    'closed',
    `Runtime Host transport failed: ${error.message}`,
    {
      cause: error,
    },
  );
}
