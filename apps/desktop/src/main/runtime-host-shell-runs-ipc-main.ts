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

import { randomUUID } from 'node:crypto';
import type { ShellRunUpdate } from '@maka/core/events';
import type { ShellRunPtySnapshot } from '@maka/runtime/shell-run-contract';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { RuntimeHostSessionObserverTarget } from './runtime-host-session-observer.js';

export type RuntimeHostShellRunsClient = Pick<
  DesktopRuntimeHostClient,
  | 'acquireRuntimeResourceController'
  | 'controlRuntimeResource'
  | 'getRuntimeResource'
  | 'listRuntimeResources'
  | 'releaseRuntimeResourceController'
  | 'startRuntimeResource'
  | 'stopRuntimeResource'
>;

export function registerRuntimeHostShellRunsIpc(
  deps: {
    client: RuntimeHostShellRunsClient;
    newId?: () => string;
    sessionObserver: {
      observe(
        sessionId: string,
        observerId: string,
        target: RuntimeHostSessionObserverTarget,
      ): Promise<void>;
      unobserve(observerId: string): Promise<void>;
    };
  },
  ipcMain: ReconnectableReadIpcMain,
): { close(): Promise<void> } {
  const newId = deps.newId ?? randomUUID;
  const controllers = new RuntimeResourceControllers(
    deps.client,
    newId,
    deps.sessionObserver,
  );

  handleReconnectableRead(ipcMain, 'shell-runs:list', (_event, sessionId: unknown) =>
    deps.client.listRuntimeResources(requiredId(sessionId, 'Session')),
  );
  ipcMain.handle('shell-runs:start', async (_event, sessionId: unknown) => {
    const normalizedSessionId = requiredId(sessionId, 'Session');
    const started = await deps.client.startRuntimeResource({
      sessionId: normalizedSessionId,
      launchId: `desktop-terminal-${newId()}`,
    });
    return requiredRuntimeResource(
      await deps.client.getRuntimeResource(normalizedSessionId, started.resource.ref),
    );
  });
  ipcMain.handle('shell-runs:attach', (event, value: unknown) =>
    controllers.attach(
      runtimeResourceIdentity(value, 'attach'),
      event.sender as RuntimeHostSessionObserverTarget,
    ),
  );
  ipcMain.handle('shell-runs:detach', (_event, value: unknown) =>
    controllers.detach(runtimeResourceIdentity(value, 'detach')),
  );
  ipcMain.handle('shell-runs:write', (_event, value: unknown) =>
    controllers.control(runtimeResourceControl(value)),
  );
  ipcMain.handle('shell-runs:stop', async (_event, value: unknown) => {
    const input = runtimeResourceIdentity(value, 'stop');
    await controllers.stop(input);
    return deps.client.getRuntimeResource(input.sessionId, input.ref);
  });

  return { close: () => controllers.close() };
}

interface RuntimeResourceIdentity {
  readonly sessionId: string;
  readonly ref: string;
}

interface RuntimeResourceControl extends RuntimeResourceIdentity {
  readonly input?: string;
  readonly size?: { readonly cols: number; readonly rows: number };
}

interface RuntimeResourceControllerState {
  readonly controllerId: string;
  readonly observerId: string;
  nextSequence: number;
}

class RuntimeResourceControllers {
  readonly #client: RuntimeHostShellRunsClient;
  readonly #newId: () => string;
  readonly #sessionObserver: {
    observe(
      sessionId: string,
      observerId: string,
      target: RuntimeHostSessionObserverTarget,
    ): Promise<void>;
    unobserve(observerId: string): Promise<void>;
  };
  readonly #states = new Map<string, RuntimeResourceControllerState>();
  readonly #tails = new Map<string, Promise<void>>();

  constructor(
    client: RuntimeHostShellRunsClient,
    newId: () => string,
    sessionObserver: {
      observe(
        sessionId: string,
        observerId: string,
        target: RuntimeHostSessionObserverTarget,
      ): Promise<void>;
      unobserve(observerId: string): Promise<void>;
    },
  ) {
    this.#client = client;
    this.#newId = newId;
    this.#sessionObserver = sessionObserver;
  }

  attach(
    input: RuntimeResourceIdentity,
    target: RuntimeHostSessionObserverTarget,
  ): Promise<ShellRunPtySnapshot> {
    return this.#run(input, async () => {
      const state = this.#state(input);
      await this.#sessionObserver.observe(input.sessionId, state.observerId, target);
      return this.#acquire(input, state);
    });
  }

  control(input: RuntimeResourceControl) {
    return this.#run(input, async () => {
      let state = this.#states.get(resourceIdentity(input));
      if (!state) {
        state = this.#state(input);
        await this.#acquire(input, state);
      }
      if (!state) throw new Error('Runtime Resource controller was not acquired');
      const sequence = state.nextSequence;
      await this.#client.controlRuntimeResource({
        sessionId: input.sessionId,
        ref: input.ref,
        controllerId: state.controllerId,
        sequence,
        control: protocolControl(input),
      });
      state.nextSequence = sequence + 1;
      return this.#client.getRuntimeResource(input.sessionId, input.ref);
    });
  }

  detach(input: RuntimeResourceIdentity): Promise<void> {
    return this.#run(input, async () => {
      const state = this.#states.get(resourceIdentity(input));
      if (!state) return;
      await this.#client.releaseRuntimeResourceController({
        ...input,
        controllerId: state.controllerId,
      });
      this.#states.delete(resourceIdentity(input));
      await this.#releaseObservation(state);
    });
  }

  stop(input: RuntimeResourceIdentity): Promise<void> {
    return this.#run(input, async () => {
      await this.#client.stopRuntimeResource(input);
      const state = this.#states.get(resourceIdentity(input));
      this.#states.delete(resourceIdentity(input));
      if (state) await this.#releaseObservation(state);
    });
  }

  async close(): Promise<void> {
    const states = [...this.#states.entries()];
    this.#states.clear();
    const results = await Promise.allSettled(
      states.flatMap(([key, state]) => {
        const [sessionId, ref] = parseResourceIdentity(key);
        return [
          this.#client.releaseRuntimeResourceController({
            sessionId,
            ref,
            controllerId: state.controllerId,
          }),
          this.#releaseObservation(state),
        ];
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  async #run<T>(input: RuntimeResourceIdentity, operation: () => Promise<T>): Promise<T> {
    const key = resourceIdentity(input);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  #state(input: RuntimeResourceIdentity): RuntimeResourceControllerState {
    const key = resourceIdentity(input);
    const existing = this.#states.get(key);
    if (existing) return existing;
    const controllerId = `desktop-terminal-controller-${this.#newId()}`;
    const state = {
      controllerId,
      observerId: `${controllerId}:session-events`,
      nextSequence: 1,
    };
    this.#states.set(key, state);
    return state;
  }

  async #acquire(
    input: RuntimeResourceIdentity,
    state: RuntimeResourceControllerState,
  ): Promise<ShellRunPtySnapshot> {
    const key = resourceIdentity(input);
    let acquired: Awaited<
      ReturnType<RuntimeHostShellRunsClient['acquireRuntimeResourceController']>
    >;
    try {
      acquired = await this.#client.acquireRuntimeResourceController({
        sessionId: input.sessionId,
        ref: input.ref,
        controllerId: state.controllerId,
      });
    } catch (error) {
      if (error instanceof RuntimeHostOperationError && this.#states.get(key) === state) {
        this.#states.delete(key);
        await this.#releaseObservation(state).catch(() => undefined);
      }
      throw error;
    }
    state.nextSequence = acquired.nextSequence;
    return acquired.pty;
  }

  async #releaseObservation(state: RuntimeResourceControllerState): Promise<void> {
    await this.#sessionObserver.unobserve(state.observerId);
  }
}

function protocolControl(input: RuntimeResourceControl) {
  if (input.input !== undefined && input.size !== undefined) {
    return { kind: 'input_and_resize' as const, input: input.input, ...input.size };
  }
  if (input.input !== undefined) return { kind: 'input' as const, input: input.input };
  if (input.size !== undefined) return { kind: 'resize' as const, ...input.size };
  throw new Error('Terminal control is empty');
}

function runtimeResourceIdentity(value: unknown, action: string): RuntimeResourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid terminal ${action} input`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'sessionId' && key !== 'ref')) {
    throw new TypeError(`Invalid terminal ${action} input`);
  }
  return {
    sessionId: requiredId(record.sessionId, 'Session'),
    ref: requiredId(record.ref, 'terminal ref'),
  };
}

function runtimeResourceControl(value: unknown): RuntimeResourceControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid terminal control input');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'sessionId' && key !== 'ref' && key !== 'input' && key !== 'size',
    )
  ) {
    throw new TypeError('Invalid terminal control input');
  }
  const input = record.input;
  const size = record.size;
  if (input !== undefined && typeof input !== 'string') {
    throw new TypeError('Invalid terminal input');
  }
  let normalizedSize: { cols: number; rows: number } | undefined;
  if (size !== undefined) {
    if (!size || typeof size !== 'object' || Array.isArray(size)) {
      throw new TypeError('Invalid terminal size');
    }
    const dimensions = size as Record<string, unknown>;
    if (
      Object.keys(dimensions).some((key) => key !== 'cols' && key !== 'rows')
      || !Number.isInteger(dimensions.cols)
      || !Number.isInteger(dimensions.rows)
    ) {
      throw new TypeError('Invalid terminal size');
    }
    normalizedSize = {
      cols: dimensions.cols as number,
      rows: dimensions.rows as number,
    };
  }
  if (input === undefined && normalizedSize === undefined) {
    throw new TypeError('Terminal control is empty');
  }
  return {
    ...runtimeResourceIdentity(
      { sessionId: record.sessionId, ref: record.ref },
      'control',
    ),
    ...(input === undefined ? {} : { input }),
    ...(normalizedSize === undefined ? {} : { size: normalizedSize }),
  };
}

function resourceIdentity(input: RuntimeResourceIdentity): string {
  return `${input.sessionId}\0${input.ref}`;
}

function parseResourceIdentity(identity: string): [sessionId: string, ref: string] {
  const separator = identity.indexOf('\0');
  if (separator < 0) throw new Error('Invalid Runtime Resource controller identity');
  return [identity.slice(0, separator), identity.slice(separator + 1)];
}

function requiredRuntimeResource(resource: ShellRunUpdate | null): ShellRunUpdate {
  if (!resource) throw new Error('Terminal started without a Runtime Resource projection');
  return resource;
}

function requiredId(value: unknown, name: string, maxLength = 512): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`Invalid ${name} id`);
  }
  return value;
}
