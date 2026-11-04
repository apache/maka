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

import { writeSync } from 'node:fs';

/** Pipe writes supply backpressure; only the latest durable acknowledgement is retained. */
export class Channel {
  #sent = 0;
  #committed = 0;
  #waiting = null;
  #failure;
  #write;

  constructor(write = (value) => writeSync(1, value)) {
    this.#write = write;
  }

  publish(body) {
    if (this.#failure !== undefined) throw this.#failure;
    const sequence = this.#sent + 1;
    const bytes = Buffer.from(`${JSON.stringify({ sequence, ...body })}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const count = this.#write(bytes.subarray(offset));
      if (count <= 0) throw new Error('OAR output pipe made no progress');
      offset += count;
    }
    this.#sent = sequence;
    return sequence;
  }

  acknowledge(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.#sent)
      throw new Error('Invalid OAR output acknowledgement');
    this.#committed = Math.max(this.#committed, sequence);
    if (this.#waiting && this.#committed >= this.#waiting.sequence) {
      this.#waiting.resolve();
      this.#waiting = null;
    }
  }

  committed(signal) {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#committed >= this.#sent || signal?.aborted) return Promise.resolve();
    if (this.#waiting) throw new Error('Concurrent OAR output settlement');
    const { promise, resolve, reject } = Promise.withResolvers();
    this.#waiting = { sequence: this.#sent, resolve, reject };
    const cancelled = () => {
      if (this.#waiting?.resolve === resolve) this.#waiting = null;
      resolve();
    };
    signal?.addEventListener('abort', cancelled, { once: true });
    return promise.finally(() => signal?.removeEventListener('abort', cancelled));
  }

  fail(error) {
    this.#failure = error;
    this.#waiting?.reject(error);
    this.#waiting = null;
  }
}
