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

import type { ClientCapabilityProvider } from '@maka/runtime-host/client';

export type McpCapabilityPublicationState =
  | 'unavailable'
  | 'publishing'
  | 'published'
  | 'not_published'
  | 'error';

interface McpCapabilityPublicationOptions {
  readonly connectionIdentity: () => string | undefined;
  readonly revision: () => number;
  readonly createProvider: () => ClientCapabilityProvider | undefined;
  readonly replace: (provider: ClientCapabilityProvider) => Promise<unknown>;
  readonly unregister: () => Promise<unknown>;
  readonly onState: (state: McpCapabilityPublicationState) => void;
}

/** Coalesces MCP snapshots and never commits a publication from an obsolete connection. */
export class McpCapabilityPublication {
  readonly #options: McpCapabilityPublicationOptions;
  #requested = false;
  #task: Promise<void> | undefined;
  #closeTask: Promise<void> | undefined;
  #closed = false;
  #state: McpCapabilityPublicationState = 'unavailable';
  #published: { identity: string; revision: number; registered: boolean } | undefined;

  constructor(options: McpCapabilityPublicationOptions) {
    this.#options = options;
  }

  invalidate(): void {
    this.#published = undefined;
  }

  request(): void {
    if (this.#closed) return;
    this.#requested = true;
    if (this.#task) return;
    this.#task = this.#run().finally(() => {
      this.#task = undefined;
      if (this.#requested && !this.#closed) this.request();
    });
  }

  async settle(): Promise<McpCapabilityPublicationState> {
    this.request();
    while (this.#task) await this.#task;
    return this.#closed ? 'unavailable' : this.#state;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#requested = false;
    await this.#task;
    try {
      if (
        this.#published?.registered &&
        this.#published.identity === this.#options.connectionIdentity()
      ) {
        await this.#options.unregister();
      }
    } finally {
      this.#published = undefined;
    }
  }

  async #run(): Promise<void> {
    while (this.#requested && !this.#closed) {
      this.#requested = false;
      await this.#publish();
    }
  }

  async #publish(): Promise<void> {
    const identity = this.#options.connectionIdentity();
    if (identity === undefined) {
      this.#setState('unavailable');
      return;
    }
    const revision = this.#options.revision();
    if (this.#published?.identity === identity && this.#published.revision === revision) {
      this.#setState(this.#published.registered ? 'published' : 'not_published');
      return;
    }
    let provider: ClientCapabilityProvider | undefined;
    this.#setState('publishing');
    try {
      provider = this.#options.createProvider();
      if (provider) await this.#options.replace(provider);
      else if (this.#published?.identity === identity && this.#published.registered) {
        await this.#options.unregister();
      }
    } catch {
      try {
        await provider?.close?.();
      } catch {
        /* Rejected provider cleanup is best effort. */
      }
      if (this.#isCurrent(identity, revision)) this.#setState('error');
      else if (!this.#closed) this.#requested = true;
      return;
    }
    // Even an obsolete snapshot may have committed on the current connection.
    // Retain that fact so an empty replacement or close can unregister it.
    if (this.#options.connectionIdentity() === identity) {
      this.#published = { identity, revision, registered: provider !== undefined };
    }
    if (!this.#isCurrent(identity, revision)) {
      if (!this.#closed) this.#requested = true;
      return;
    }
    this.#setState(provider ? 'published' : 'not_published');
  }

  #isCurrent(identity: string, revision: number): boolean {
    return (
      !this.#closed &&
      this.#options.connectionIdentity() === identity &&
      this.#options.revision() === revision
    );
  }

  #setState(state: McpCapabilityPublicationState): void {
    if (this.#closed) return;
    this.#state = state;
    this.#options.onState(state);
  }
}
