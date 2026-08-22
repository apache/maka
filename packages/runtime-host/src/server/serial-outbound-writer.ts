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

import {
  encodeProtocolMessage,
  type EncodedProtocolMessage,
  type HostFrame,
} from '../protocol/index.js';
import type { RuntimeHostMessageTransport } from '../transport/message-transport.js';

const MAX_QUEUED_FRAMES = 64;
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

interface QueuedFrame {
  message: EncodedProtocolMessage;
  resolve(): void;
  reject(error: Error): void;
}

export interface OutboundWriteReceipt {
  readonly flushed: Promise<void>;
}

export class RuntimeHostOutboundQueueError extends Error {
  constructor(readonly code: 'frame_limit' | 'byte_limit') {
    super(
      code === 'frame_limit'
        ? 'Runtime Host outbound queue exceeded its frame bound'
        : 'Runtime Host outbound queue exceeded its byte bound',
    );
    this.name = 'RuntimeHostOutboundQueueError';
  }
}

export class BoundedSerialOutboundWriter {
  readonly #transport: RuntimeHostMessageTransport;
  readonly #onFailure: () => void;
  readonly #queue: QueuedFrame[] = [];
  #queuedBytes = 0;
  #writing = false;
  #drainTask: Promise<void> | undefined;
  #closed = false;

  constructor(transport: RuntimeHostMessageTransport, onFailure: () => void) {
    this.#transport = transport;
    this.#onFailure = onFailure;
  }

  enqueue(frame: HostFrame): OutboundWriteReceipt {
    if (this.#closed) {
      throw new Error('Runtime Host outbound writer is closed');
    }

    let message: EncodedProtocolMessage;
    try {
      message = encodeProtocolMessage(frame);
    } catch (error) {
      const failure = asError(error);
      this.#fail(failure);
      throw failure;
    }
    if (this.#queue.length >= MAX_QUEUED_FRAMES) {
      const failure = new RuntimeHostOutboundQueueError('frame_limit');
      this.#fail(failure);
      throw failure;
    }
    if (this.#queuedBytes + message.byteLength > MAX_QUEUED_BYTES) {
      const failure = new RuntimeHostOutboundQueueError('byte_limit');
      this.#fail(failure);
      throw failure;
    }

    const flushed = new Promise<void>((resolve, reject) => {
      this.#queue.push({ message, resolve, reject });
      this.#queuedBytes += message.byteLength;
      if (!this.#writing) {
        this.#writing = true;
        this.#drainTask = this.#drain();
      }
    });
    return { flushed };
  }

  settled(): Promise<void> {
    return this.#drainTask ?? Promise.resolve();
  }

  close(
    error = new Error('Runtime Host outbound writer closed before the frame was flushed'),
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const queued of this.#queue.splice(0)) queued.reject(error);
    this.#queuedBytes = 0;
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#closed) {
        const queued = this.#queue[0];
        if (!queued) return;
        try {
          await this.#transport.write(queued.message);
        } catch (error) {
          this.#fail(asError(error));
          return;
        }
        if (this.#closed) return;
        this.#queue.shift();
        this.#queuedBytes -= queued.message.byteLength;
        queued.resolve();
      }
    } catch (error) {
      this.#fail(asError(error));
    } finally {
      this.#writing = false;
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.close(error);
    this.#onFailure();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
