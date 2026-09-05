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
import { TextDecoder } from 'node:util';
import WebSocket, { type RawData } from 'ws';
import { RUNTIME_HOST_MAX_MESSAGE_BYTES, type EncodedProtocolMessage } from '../protocol/index.js';
import { RuntimeHostTransportError } from './framed-transport.js';
import type { RuntimeHostMessageTransport } from './message-transport.js';

const MAX_QUEUED_MESSAGES = 64;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 2 * 1024 * 1024;

interface QueuedMessage {
  readonly value: unknown;
  readonly encodedBytes: number;
}

interface ReadWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export class WebSocketTransport implements RuntimeHostMessageTransport {
  readonly closed: Promise<void>;
  readonly #socket: WebSocket;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #queue: QueuedMessage[] = [];
  #queuedBytes = 0;
  #pendingWriteBytes = 0;
  #waiter: ReadWaiter | undefined;
  #failure: Error | undefined;
  #readTerminal: RuntimeHostTransportError | undefined;
  #closeAfterFlush = false;
  #resolveClosed!: () => void;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on('message', (data, isBinary) => this.#receive(data, isBinary));
    socket.once('error', (error) => this.#fail(transportFailure(error)));
    socket.once('close', () => {
      this.#endRead();
      this.#resolveClosed();
    });
  }

  read(timeoutMs: number): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const queued = this.#queue.shift();
    if (queued) {
      this.#queuedBytes -= queued.encodedBytes;
      return Promise.resolve(queued.value);
    }
    if (this.#readTerminal) return Promise.reject(this.#readTerminal);
    if (this.#waiter) {
      return Promise.reject(
        new RuntimeHostTransportError(
          'concurrent_read',
          'Only one Runtime Host message read may be pending',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: ReadWaiter = { resolve, reject };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (this.#waiter !== waiter) return;
          this.#fail(
            new RuntimeHostTransportError(
              'read_timeout',
              'Timed out waiting for Runtime Host message',
            ),
          );
        }, timeoutMs);
      }
      this.#waiter = waiter;
    });
  }

  write(message: EncodedProtocolMessage): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RuntimeHostTransportError('closed', 'WebSocket is not open'));
    }
    if (this.#pendingWriteBytes + message.byteLength > MAX_PENDING_WRITE_BYTES) {
      const error = new RuntimeHostTransportError(
        'outbound_queue_full',
        'Runtime Host WebSocket outbound queue is full',
      );
      this.#fail(error);
      return Promise.reject(error);
    }
    this.#pendingWriteBytes += message.byteLength;
    return new Promise((resolve, reject) => {
      this.#socket.send(message, { binary: false, compress: false }, (error) => {
        this.#pendingWriteBytes -= message.byteLength;
        if (error) {
          const failure = transportFailure(asError(error));
          this.#fail(failure);
          reject(failure);
          return;
        }
        resolve();
        if (this.#closeAfterFlush && this.#pendingWriteBytes === 0) this.#socket.close(1000);
      });
    });
  }

  closeAfterFlush(): void {
    this.#closeAfterFlush = true;
    if (this.#pendingWriteBytes === 0 && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(1000);
    }
  }

  abort(error?: Error): void {
    if (error) this.#fail(error);
    this.#socket.terminate();
  }

  #receive(data: RawData, isBinary: boolean): void {
    try {
      if (isBinary) {
        throw new RuntimeHostProtocolError(
          'invalid_frame',
          'Runtime Host WebSocket messages must be text',
        );
      }
      const encoded = toBuffer(data);
      if (encoded.byteLength === 0) {
        throw new RuntimeHostProtocolError('invalid_frame', 'Runtime Host message is empty');
      }
      if (encoded.byteLength > RUNTIME_HOST_MAX_MESSAGE_BYTES) {
        throw new RuntimeHostProtocolError(
          'frame_too_large',
          'Runtime Host message exceeds the byte limit',
        );
      }
      const value = decodeMessage(this.#decoder, encoded);
      if (this.#waiter) {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(value);
        return;
      }
      if (
        this.#queue.length >= MAX_QUEUED_MESSAGES ||
        this.#queuedBytes + encoded.byteLength > MAX_QUEUED_BYTES
      ) {
        throw new RuntimeHostTransportError(
          'inbound_queue_full',
          'Runtime Host WebSocket inbound queue is full',
        );
      }
      this.#queue.push({ value, encodedBytes: encoded.byteLength });
      this.#queuedBytes += encoded.byteLength;
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #endRead(): void {
    if (this.#failure || this.#readTerminal) return;
    this.#readTerminal = new RuntimeHostTransportError(
      'read_eof',
      'Runtime Host WebSocket read side ended',
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
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (
      this.#socket.readyState === WebSocket.OPEN ||
      this.#socket.readyState === WebSocket.CONNECTING
    ) {
      this.#socket.terminate();
    }
  }
}

function decodeMessage(decoder: TextDecoder, encoded: Buffer): unknown {
  let text: string;
  try {
    text = decoder.decode(encoded);
  } catch {
    throw new RuntimeHostProtocolError('invalid_utf8', 'Runtime Host message is not valid UTF-8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeHostProtocolError('invalid_json', 'Runtime Host message is not valid JSON');
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function transportFailure(error: Error): Error {
  if (error instanceof RuntimeHostTransportError || error instanceof RuntimeHostProtocolError) {
    return error;
  }
  return new RuntimeHostTransportError(
    'closed',
    `Runtime Host WebSocket transport failed: ${error.message}`,
    { cause: error },
  );
}
