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
  MakaClientRemoteInput,
  MakaClientRemoteMethodName,
  MakaClientRemoteOutput,
  MakaClientRemoteStreamInput,
  MakaClientRemoteStreamItem,
  MakaClientRemoteStreamName,
} from '@maka/core/client-plugin-bridge';
import {
  Service,
  type Awaitable,
  type Context,
  type Disposable,
  type StandardSchema,
} from './plugin-kernel.js';
import { PluginScopeRegistry } from './plugin-scope-registry.js';
import {
  MakaPluginRuntimeError,
  pluginIdentity,
  registerPluginContribution,
  type MakaContributionIdentity,
  type MakaPluginRootId,
} from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly clientBridge: PluginClientBridgeService;
  }
}

export interface PluginClientRemoteContext {
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}

export interface PluginClientRpcDefinition<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly input?: StandardSchema;
  readonly output?: StandardSchema;
  invoke(input: Input, context: PluginClientRemoteContext): Awaitable<Output>;
}

export interface PluginClientStreamDefinition<Input = unknown, Item = unknown> {
  readonly name: string;
  readonly input?: StandardSchema;
  readonly item?: StandardSchema;
  open(input: Input, context: PluginClientRemoteContext): Awaitable<AsyncIterable<Item>>;
}

export interface PluginClientRemoteTarget {
  readonly extensionId: string;
  readonly sessionId?: string;
}

export interface PluginClientStreamBinding<Item = unknown> {
  readonly identity: MakaContributionIdentity;
  next(): Promise<IteratorResult<Item>>;
  close(): Promise<void>;
}

interface ActiveInvocation {
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  readonly onAbort: () => void;
  readonly signal?: AbortSignal;
}

interface RegisteredRpc extends MakaContributionIdentity {
  readonly definition: PluginClientRpcDefinition;
  readonly token: symbol;
  readonly active: Set<ActiveInvocation>;
  retired: boolean;
}

interface RegisteredStream extends MakaContributionIdentity {
  readonly definition: PluginClientStreamDefinition;
  readonly token: symbol;
  readonly active: Set<ActiveInvocation>;
  retired: boolean;
}

export class PluginClientBridgeError extends Error {
  readonly name = 'PluginClientBridgeError';

  constructor(
    readonly code: 'not_found' | 'invalid_input' | 'retired',
    message: string,
  ) {
    super(message);
  }
}

/** Fiber-owned Host half of one package's typed Client Remote contract. */
export class PluginClientBridgeService extends Service {
  private readonly rpcs = new PluginScopeRegistry<RegisteredRpc>();
  private readonly streams = new PluginScopeRegistry<RegisteredStream>();

  constructor(ctx: Context) {
    super(ctx, 'clientBridge');
  }

  rpc<const Name extends MakaClientRemoteMethodName>(
    definition: Omit<
      PluginClientRpcDefinition<MakaClientRemoteInput<Name>, MakaClientRemoteOutput<Name>>,
      'name'
    > & { readonly name: Name },
  ): Disposable<Promise<void>>;
  rpc(definition: PluginClientRpcDefinition): Disposable<Promise<void>>;
  rpc(definition: PluginClientRpcDefinition): Disposable<Promise<void>> {
    validateDefinition(definition, 'RPC');
    const identity = hostIdentity(this.ctx);
    return registerPluginContribution(
      this.ctx,
      `clientBridge.rpc(${JSON.stringify(definition.name)})`,
      () => this.publish(this.rpcs, identity, definition),
    );
  }

  stream<const Name extends MakaClientRemoteStreamName>(
    definition: Omit<
      PluginClientStreamDefinition<
        MakaClientRemoteStreamInput<Name>,
        MakaClientRemoteStreamItem<Name>
      >,
      'name'
    > & { readonly name: Name },
  ): Disposable<Promise<void>>;
  stream(definition: PluginClientStreamDefinition): Disposable<Promise<void>>;
  stream(definition: PluginClientStreamDefinition): Disposable<Promise<void>> {
    validateDefinition(definition, 'Stream');
    const identity = hostIdentity(this.ctx);
    return registerPluginContribution(
      this.ctx,
      `clientBridge.stream(${JSON.stringify(definition.name)})`,
      () => this.publish(this.streams, identity, definition),
    );
  }

  async invoke(
    target: PluginClientRemoteTarget,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.prepareInvoke(target, name, input, signal)();
  }

  /** Capture the verified registration before releasing the platform mutation lock. */
  prepareInvoke(
    target: PluginClientRemoteTarget,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): () => Promise<unknown> {
    const entry = resolve(this.rpcs, target, name);
    return async () => await this.invokeEntry(entry, target, name, input, signal);
  }

  private async invokeEntry(
    entry: RegisteredRpc,
    target: PluginClientRemoteTarget,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const active = activate(entry, name, signal);
    try {
      const decoded = await untilAborted(active.abort.signal, () =>
        validateInputSchema(entry.definition.input, input, `Client RPC ${name} input`),
      );
      const output = await untilAborted(active.abort.signal, () =>
        entry.definition.invoke(decoded, {
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          signal: active.abort.signal,
        }),
      );
      if (entry.retired) throw retiredError(name);
      return await untilAborted(active.abort.signal, () =>
        validateSchema(entry.definition.output, output, `Client RPC ${name} output`),
      );
    } finally {
      finish(entry, active);
    }
  }

  async open(
    target: PluginClientRemoteTarget,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<PluginClientStreamBinding> {
    return await this.prepareOpen(target, name, input, signal)();
  }

  /** Capture the verified registration before releasing the platform mutation lock. */
  prepareOpen(
    target: PluginClientRemoteTarget,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): () => Promise<PluginClientStreamBinding> {
    const entry = resolve(this.streams, target, name);
    return async () => await this.openEntry(entry, target, name, input, signal);
  }

  private async openEntry(
    entry: RegisteredStream,
    target: PluginClientRemoteTarget,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<PluginClientStreamBinding> {
    const active = activate(entry, name, signal);
    try {
      const decoded = await untilAborted(active.abort.signal, () =>
        validateInputSchema(entry.definition.input, input, `Client Stream ${name} input`),
      );
      const iterable = await untilAborted(
        active.abort.signal,
        () =>
          entry.definition.open(decoded, {
            ...(target.sessionId ? { sessionId: target.sessionId } : {}),
            signal: active.abort.signal,
          }),
        (late) => {
          void Promise.resolve()
            .then(() => late[Symbol.asyncIterator]().return?.())
            .catch(() => undefined);
        },
      );
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
        throw new TypeError(`Client Stream ${name} did not return an AsyncIterable`);
      }
      const iterator = iterable[Symbol.asyncIterator]();
      let closed = false;
      const pending = new Set<() => void>();
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        active.abort.signal.removeEventListener('abort', onAbort);
        active.abort.abort();
        for (const settle of pending) settle();
        pending.clear();
        // A generator's return queues behind its pending next. Do not let a
        // non-cooperative producer block connection cleanup or Fiber retirement.
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => undefined);
        finish(entry, active);
      };
      const onAbort = () => {
        void close();
      };
      active.abort.signal.addEventListener('abort', onAbort, { once: true });
      if (active.abort.signal.aborted) await close();
      return Object.freeze({
        identity: freezeIdentity(entry),
        next: async () => {
          if (closed || entry.retired) throw retiredError(name);
          let settle!: () => void;
          const stopped = new Promise<IteratorReturnResult<undefined>>((resolve) => {
            settle = () => resolve({ done: true, value: undefined });
          });
          pending.add(settle);
          try {
            const result = await Promise.race([iterator.next(), stopped]);
            if (closed || result.done) {
              await close();
              return Object.freeze({ done: true, value: undefined });
            }
            const value = await Promise.race([
              validateSchema(entry.definition.item, result.value, `Client Stream ${name} item`),
              stopped.then(() => undefined),
            ]);
            if (closed) return Object.freeze({ done: true, value: undefined });
            return Object.freeze({ done: false, value });
          } finally {
            pending.delete(settle);
          }
        },
        close,
      });
    } catch (error) {
      finish(entry, active);
      throw error;
    }
  }

  private publish<T extends RegisteredRpc | RegisteredStream>(
    registry: PluginScopeRegistry<T>,
    identity: MakaContributionIdentity,
    definition: T['definition'],
  ): () => Promise<void> {
    const rootId = identity.scopeId as MakaPluginRootId;
    const key = registrationKey(identity.extensionId, definition.name);
    const existing = registry.get(rootId, key);
    if (existing && existing.entryId !== identity.entryId) {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `Client Remote ${JSON.stringify(definition.name)} is already registered by ${existing.entryId}`,
      );
    }
    const entry = {
      ...identity,
      definition: Object.freeze({ ...definition }),
      token: Symbol(definition.name),
      active: new Set<ActiveInvocation>(),
      retired: false,
    } as unknown as T;
    return registry.publish(rootId, key, entry, {
      onRetired: async (retired) => {
        for (const invocation of retired.active) {
          invocation.abort.abort(retiredError(definition.name));
        }
        await Promise.allSettled([...retired.active].map(({ settled }) => settled));
      },
    });
  }
}

function hostIdentity(ctx: Context): MakaContributionIdentity {
  const identity = pluginIdentity(ctx);
  if (identity.scopeId === 'desktop-ui') {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      'Client Remote handlers must be registered by a Host composition entry',
    );
  }
  return identity;
}

function resolve<T extends RegisteredRpc | RegisteredStream>(
  registry: PluginScopeRegistry<T>,
  target: PluginClientRemoteTarget,
  name: string,
): T {
  validateMethodName(name);
  const key = registrationKey(target.extensionId, name);
  const entry = target.sessionId
    ? registry.visible(assertSessionId(target.sessionId)).get(key)
    : registry.get('profile', key);
  if (!entry || entry.retired) {
    throw new PluginClientBridgeError('not_found', `Client Remote is unavailable: ${name}`);
  }
  return entry;
}

function activate<T extends RegisteredRpc | RegisteredStream>(
  entry: T,
  name: string,
  signal?: AbortSignal,
): ActiveInvocation {
  if (entry.retired) throw retiredError(name);
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const active: ActiveInvocation = {
    abort,
    settled,
    settle,
    onAbort,
    ...(signal ? { signal } : {}),
  };
  entry.active.add(active);
  return active;
}

function untilAborted<T>(
  signal: AbortSignal,
  run: () => T | PromiseLike<T>,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    const abort = () => {
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (settled) {
            late?.(value);
            return;
          }
          settled = true;
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
      )
      .catch(() => undefined);
  });
}

function finish(entry: RegisteredRpc | RegisteredStream, active: ActiveInvocation): void {
  entry.active.delete(active);
  active.signal?.removeEventListener('abort', active.onAbort);
  active.settle();
}

function freezeIdentity(entry: MakaContributionIdentity): MakaContributionIdentity {
  return Object.freeze({
    entryId: entry.entryId,
    scopeId: entry.scopeId,
    extensionId: entry.extensionId,
    generation: entry.generation,
  });
}

async function validateSchema(
  schema: StandardSchema | undefined,
  value: unknown,
  label: string,
): Promise<unknown> {
  if (!schema) return value;
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    throw new TypeError(
      `${label} is invalid: ${result.issues.map(({ message }) => message).join('; ')}`,
    );
  }
  return result.value;
}

async function validateInputSchema(
  schema: StandardSchema | undefined,
  value: unknown,
  label: string,
): Promise<unknown> {
  try {
    return await validateSchema(schema, value, label);
  } catch (error) {
    throw new PluginClientBridgeError(
      'invalid_input',
      error instanceof Error ? error.message : `${label} is invalid`,
    );
  }
}

function retiredError(name: string): PluginClientBridgeError {
  return new PluginClientBridgeError('retired', `Client Remote retired while active: ${name}`);
}

function validateDefinition(
  definition: PluginClientRpcDefinition | PluginClientStreamDefinition,
  label: string,
): void {
  validateMethodName(definition.name);
  if (
    ('invoke' in definition && typeof definition.invoke !== 'function') ||
    ('open' in definition && typeof definition.open !== 'function')
  ) {
    throw new TypeError(`Client ${label} handler is required`);
  }
}

function validateMethodName(name: string): void {
  if (!/^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u.test(name) || name.length > 128) {
    throw new TypeError('Client Remote name is invalid');
  }
}

function registrationKey(extensionId: string, name: string): string {
  return `${extensionId}\u0000${name}`;
}

function assertSessionId(value: string): string {
  if (!value || value.length > 128 || /[\0\r\n]/u.test(value)) {
    throw new TypeError('Client Remote Session id is invalid');
  }
  return value;
}
