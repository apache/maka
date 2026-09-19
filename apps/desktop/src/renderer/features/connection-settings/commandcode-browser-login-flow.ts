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

import type {
  CommandCodeBrowserLoginBridge,
  CommandCodeBrowserLoginCredentials,
  CommandCodeBrowserLoginFailureReason,
  CommandCodeBrowserLoginResult,
  CommandCodeBrowserLoginStartInput,
} from './ports.js';

/**
 * Renderer-side failure vocabulary: the main-process reasons minus the user's
 * own cancel (which returns to idle) plus a dead bridge.
 */
export type CommandCodeBrowserLoginFlowFailure =
  | Exclude<CommandCodeBrowserLoginFailureReason, 'cancelled'>
  | 'unavailable';

export type CommandCodeBrowserLoginFlowState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'waiting'; readonly attemptId: string; readonly authUrl: string }
  | { readonly phase: 'filled'; readonly userName: string }
  | { readonly phase: 'failed'; readonly reason: CommandCodeBrowserLoginFlowFailure };

const IDLE: CommandCodeBrowserLoginFlowState = { phase: 'idle' };

/**
 * The renderer half of the browser-assisted Command Code sign-in: one attempt
 * at a time, `start` then a long `complete`, with a generation counter so a
 * cancelled or replaced attempt's late result is dropped rather than typed
 * into the key field. Framework-free so the machine is testable on its own;
 * the hint component subscribes to it.
 */
export class CommandCodeBrowserLoginFlow {
  readonly #bridge: CommandCodeBrowserLoginBridge;
  readonly #onCredentials: (credentials: CommandCodeBrowserLoginCredentials) => void;
  readonly #listeners = new Set<() => void>();
  #state: CommandCodeBrowserLoginFlowState = IDLE;
  #generation = 0;
  #attemptId: string | undefined;
  #disposed = false;

  constructor(
    bridge: CommandCodeBrowserLoginBridge,
    onCredentials: (credentials: CommandCodeBrowserLoginCredentials) => void,
  ) {
    this.#bridge = bridge;
    this.#onCredentials = onCredentials;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): CommandCodeBrowserLoginFlowState => this.#state;

  async start(input: CommandCodeBrowserLoginStartInput = {}): Promise<void> {
    if (this.#disposed) return;
    if (this.#state.phase === 'starting' || this.#state.phase === 'waiting') return;
    const generation = ++this.#generation;
    this.#set({ phase: 'starting' });

    let started: Awaited<ReturnType<CommandCodeBrowserLoginBridge['start']>>;
    try {
      started = await this.#bridge.start(input);
    } catch {
      if (this.#isStale(generation)) return;
      this.#set({ phase: 'failed', reason: 'unavailable' });
      return;
    }
    if (this.#isStale(generation)) {
      // Superseded while binding: the listener is live on a port nobody is
      // watching. Release it rather than letting the window run out.
      if (started.ok) void this.#bridge.cancel(started.attemptId).catch(() => {});
      return;
    }
    if (!started.ok) {
      this.#set({ phase: 'failed', reason: started.reason });
      return;
    }

    this.#attemptId = started.attemptId;
    this.#set({ phase: 'waiting', attemptId: started.attemptId, authUrl: started.authUrl });
    let result: CommandCodeBrowserLoginResult | { ok: false; reason: 'unavailable' };
    try {
      result = await this.#bridge.complete(started.attemptId);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (this.#isStale(generation)) return;
    this.#attemptId = undefined;
    if (result.ok) {
      this.#onCredentials(result.credentials);
      this.#set({ phase: 'filled', userName: result.credentials.userName });
      return;
    }
    // The user's own cancel returns the hint to its resting link; every
    // other end is something to tell them about.
    if (result.reason === 'cancelled') {
      this.#set(IDLE);
      return;
    }
    this.#set({ phase: 'failed', reason: result.reason });
  }

  /** Abandons the live attempt (if any) and returns to the resting link. */
  cancel(): void {
    const attemptId = this.#attemptId;
    this.#generation += 1;
    this.#attemptId = undefined;
    if (!this.#disposed) this.#set(IDLE);
    if (attemptId !== undefined) void this.#bridge.cancel(attemptId).catch(() => {});
  }

  dispose(): void {
    if (this.#disposed) return;
    this.cancel();
    this.#disposed = true;
    this.#listeners.clear();
  }

  #isStale(generation: number): boolean {
    return this.#disposed || this.#generation !== generation;
  }

  #set(next: CommandCodeBrowserLoginFlowState): void {
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
