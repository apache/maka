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

/** Request/reply correlation only; the Rust Host owns admission, effects and settlement. */
export class HostTools {
  #channel;
  #signal;
  #next = 0;
  #pending = new Map();
  #closed = false;
  #failure;

  constructor(channel, signal) {
    this.#channel = channel;
    this.#signal = signal;
  }

  definitions(tools) {
    return tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      handler: (input, { signal }) => this.call(name, input, signal),
    }));
  }

  async call(name, input, signal) {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed || this.#signal.aborted || signal.aborted)
      throw new Error('Maka Host tool call cancelled before dispatch');
    const callId = ++this.#next;
    if (!Number.isSafeInteger(callId)) throw new Error('Maka Host tool call ID exhausted');
    const reply = Promise.withResolvers();
    this.#pending.set(callId, reply);
    let cancelled = false;
    const cancel = () => {
      if (cancelled || !this.#pending.has(callId)) return;
      cancelled = true;
      try {
        this.#channel.publish({ kind: 'tool_cancel', callId });
      } catch (error) {
        this.fail(error);
      }
    };
    try {
      this.#channel.publish({ kind: 'tool_call', callId, name, input });
      signal.addEventListener('abort', cancel, { once: true });
      this.#signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted || this.#signal.aborted) cancel();
      // Cancellation requests withdrawal; it does not prove that an admitted effect settled.
      return await reply.promise;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.#signal.removeEventListener('abort', cancel);
      this.#pending.delete(callId);
    }
  }

  receive({ callId, result }) {
    const reply = this.#pending.get(callId);
    if (!reply) throw new Error('Unknown Maka Host tool reply');
    this.#pending.delete(callId);
    reply.resolve(result);
  }

  fail(error) {
    this.#failure = error;
    for (const reply of this.#pending.values()) reply.reject(error);
    this.#pending.clear();
  }

  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#pending.values()].map((reply) => reply.promise));
    if (this.#failure !== undefined) throw this.#failure;
  }
}

export function hostToolsRefusal(runtime) {
  return runtime.refusedSessionOptions?.mcpServers;
}
