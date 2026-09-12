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

import { Service, type Context, type Disposable } from './plugin-kernel.js';
import { pluginIdentity, registerPluginContribution } from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    readonly settings: PluginSettingsService;
    readonly storage: PluginStorageService;
    readonly credentials: PluginCredentialService;
    readonly authorization: PluginAuthorizationService;
  }
}

export interface PluginDataNamespace {
  readonly extensionId: string;
  readonly scopeId: string;
}
export interface PluginDataSnapshot<T = unknown> {
  readonly revision: number;
  readonly value: T | undefined;
}
export interface PluginDataMutation {
  readonly key: string;
  readonly value?: unknown;
  readonly expectedRevision?: number;
}

export interface PluginDataRuntime {
  read(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    key: string,
  ): Promise<PluginDataSnapshot>;
  list(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    prefix?: string,
  ): Promise<Readonly<Record<string, PluginDataSnapshot>>>;
  mutate(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    mutations: readonly PluginDataMutation[],
  ): Promise<Readonly<Record<string, PluginDataSnapshot>>>;
  subscribe?(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    listener: (keys: readonly string[]) => void,
  ): () => void;
  hasCredential(namespace: PluginDataNamespace, slot: string): Promise<boolean>;
  useCredential<T>(
    namespace: PluginDataNamespace,
    slot: string,
    use: (secret: string) => T | Promise<T>,
  ): Promise<T>;
  commitCredential(
    namespace: PluginDataNamespace,
    slot: string,
    secret: string,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void>;
  removeCredential(namespace: PluginDataNamespace, slot: string): Promise<void>;
}

export interface PluginSettingDefinition<T = unknown> {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly defaultValue?: T;
  readonly validate?: (value: unknown) => value is T;
  readonly secret?: boolean;
}

class PluginNamespacedDataService extends Service {
  private dataRuntime?: PluginDataRuntime;
  protected constructor(
    ctx: Context,
    name: string,
    private readonly domain: 'settings' | 'storage',
  ) {
    super(ctx, name);
  }
  bindRuntime(runtime: PluginDataRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error(`Only the Host may bind the Plugin ${this.domain} Runtime`);
    if (this.dataRuntime) throw new Error(`Plugin ${this.domain} Runtime is already bound`);
    this.dataRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.dataRuntime === runtime) this.dataRuntime = undefined;
      },
      `${this.domain}.bindRuntime()`,
    );
  }
  protected runtime(): PluginDataRuntime {
    if (!this.dataRuntime) throw new Error(`Plugin ${this.domain} Runtime is unavailable`);
    return this.dataRuntime;
  }
  protected namespace(): PluginDataNamespace {
    const { extensionId, scopeId } = pluginIdentity(this.ctx);
    return Object.freeze({ extensionId, scopeId });
  }
  protected readValue(key: string): Promise<PluginDataSnapshot> {
    return this.runtime().read(this.namespace(), this.domain, validKey(key));
  }
  protected listValues(prefix?: string): Promise<Readonly<Record<string, PluginDataSnapshot>>> {
    return this.runtime().list(
      this.namespace(),
      this.domain,
      prefix === undefined ? undefined : validPrefix(prefix),
    );
  }
  protected mutateValues(
    mutations: readonly PluginDataMutation[],
  ): Promise<Readonly<Record<string, PluginDataSnapshot>>> {
    return this.runtime().mutate(
      this.namespace(),
      this.domain,
      Object.freeze(
        mutations.map((mutation) =>
          Object.freeze({
            ...mutation,
            key: validKey(mutation.key),
            ...(mutation.value === undefined ? {} : { value: detached(mutation.value) }),
          }),
        ),
      ),
    );
  }
  protected watchValues(listener: (keys: readonly string[]) => void): () => void {
    const subscribe = this.runtime().subscribe;
    if (!subscribe) throw new Error(`Plugin ${this.domain} subscriptions are unavailable`);
    return subscribe(this.namespace(), this.domain, listener);
  }
}

/** Per-extension Settings with schema contributions, CAS revisions, and no global-policy access. */
export class PluginSettingsService extends PluginNamespacedDataService {
  private readonly definitions = new Map<string, PluginSettingDefinition>();
  constructor(ctx: Context) {
    super(ctx, 'settings', 'settings');
  }

  define<T>(definition: PluginSettingDefinition<T>): () => Promise<void> {
    validateSettingDefinition(definition);
    const identity = pluginIdentity(this.ctx);
    return registerPluginContribution(
      this.ctx,
      `settings.define(${JSON.stringify(definition.key)})`,
      () => {
        const id = `${identity.scopeId}\0${identity.extensionId}\0${definition.key}`;
        if (this.definitions.has(id))
          throw new Error(`Plugin Setting is already defined: ${definition.key}`);
        this.definitions.set(
          id,
          Object.freeze({
            ...definition,
            ...(definition.defaultValue === undefined
              ? {}
              : { defaultValue: detached(definition.defaultValue) }),
          }),
        );
        return () => {
          this.definitions.delete(id);
        };
      },
    );
  }

  async get<T = unknown>(key: string): Promise<PluginDataSnapshot<T>> {
    const snapshot = await this.readValue(key);
    if (snapshot.value !== undefined) return snapshot as PluginDataSnapshot<T>;
    const definition = this.definition(key);
    return definition?.defaultValue === undefined
      ? (snapshot as PluginDataSnapshot<T>)
      : Object.freeze({
          revision: snapshot.revision,
          value: detached(definition.defaultValue) as T,
        });
  }
  async set<T>(
    key: string,
    value: T,
    options: { readonly expectedRevision?: number } = {},
  ): Promise<PluginDataSnapshot<T>> {
    const definition = this.definition(key);
    if (!definition) throw new Error(`Plugin Setting is not defined: ${key}`);
    if (definition.secret) throw new Error(`Secret Setting must use ctx.authorization: ${key}`);
    if (definition.validate && !definition.validate(value))
      throw new TypeError(`Plugin Setting failed validation: ${key}`);
    const result = await this.mutateValues([{ key, value, ...options }]);
    return result[key] as PluginDataSnapshot<T>;
  }
  async delete(
    key: string,
    options: { readonly expectedRevision?: number } = {},
  ): Promise<PluginDataSnapshot> {
    const result = await this.mutateValues([{ key, ...options }]);
    return result[key]!;
  }
  list(prefix?: string) {
    return this.listValues(prefix);
  }
  watch(listener: (keys: readonly string[]) => void): () => void {
    return this.watchValues(listener);
  }
  private definition(key: string): PluginSettingDefinition | undefined {
    const identity = pluginIdentity(this.ctx);
    return this.definitions.get(`${identity.scopeId}\0${identity.extensionId}\0${validKey(key)}`);
  }
}

/** Per-extension durable KV/blob-safe JSON surface with atomic batch mutations. */
export class PluginStorageService extends PluginNamespacedDataService {
  constructor(ctx: Context) {
    super(ctx, 'storage', 'storage');
  }
  get<T = unknown>(key: string): Promise<PluginDataSnapshot<T>> {
    return this.readValue(key) as Promise<PluginDataSnapshot<T>>;
  }
  async set<T>(
    key: string,
    value: T,
    options: { readonly expectedRevision?: number } = {},
  ): Promise<PluginDataSnapshot<T>> {
    const result = await this.mutateValues([{ key, value, ...options }]);
    return result[key] as PluginDataSnapshot<T>;
  }
  async delete(
    key: string,
    options: { readonly expectedRevision?: number } = {},
  ): Promise<PluginDataSnapshot> {
    const result = await this.mutateValues([{ key, ...options }]);
    return result[key]!;
  }
  list(prefix?: string) {
    return this.listValues(prefix);
  }
  transaction(mutations: readonly PluginDataMutation[]) {
    if (!mutations.length) throw new TypeError('Plugin Storage transaction must not be empty');
    return this.mutateValues(mutations);
  }
  watch(listener: (keys: readonly string[]) => void): () => void {
    return this.watchValues(listener);
  }
}

export interface PluginCredentialSlot {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
}
interface RegisteredCredentialSlot {
  readonly identity: PluginDataNamespace;
  readonly definition: PluginCredentialSlot;
}
const authorizationCommit = Symbol('authorizationCommit');

/** Declared Secret Slots. Values stay in Host custody and are never enumerable. */
export class PluginCredentialService extends Service {
  private dataRuntime?: PluginDataRuntime;
  private readonly slots = new Map<string, RegisteredCredentialSlot>();
  constructor(ctx: Context) {
    super(ctx, 'credentials');
  }
  bindRuntime(runtime: PluginDataRuntime): Disposable<Promise<void>> {
    if (this.ctx.maka) throw new Error('Only the Host may bind the Credential Runtime');
    if (this.dataRuntime) throw new Error('Plugin Credential Runtime is already bound');
    this.dataRuntime = runtime;
    return this.ctx.effect(
      () => () => {
        if (this.dataRuntime === runtime) this.dataRuntime = undefined;
      },
      'credentials.bindRuntime()',
    );
  }
  declare(slot: PluginCredentialSlot): () => Promise<void> {
    validateSlot(slot);
    const identity = namespace(this.ctx);
    const id = slotId(identity, slot.name);
    return registerPluginContribution(
      this.ctx,
      `credentials.declare(${JSON.stringify(slot.name)})`,
      () => {
        if (this.slots.has(id))
          throw new Error(`Credential Slot is already declared: ${slot.name}`);
        this.slots.set(id, { identity, definition: Object.freeze({ ...slot }) });
        return () => {
          this.slots.delete(id);
        };
      },
    );
  }
  has(name: string): Promise<boolean> {
    const slot = this.requireSlot(name);
    return this.runtime().hasCredential(slot.identity, slot.definition.name);
  }
  use<T>(name: string, operation: (secret: string) => T | Promise<T>): Promise<T> {
    if (typeof operation !== 'function') throw new TypeError('Credential use callback is required');
    const slot = this.requireSlot(name);
    return this.runtime().useCredential(slot.identity, slot.definition.name, operation);
  }
  remove(name: string): Promise<void> {
    const slot = this.requireSlot(name);
    return this.runtime().removeCredential(slot.identity, slot.definition.name);
  }
  async [authorizationCommit](
    name: string,
    secret: string,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!secret) throw new TypeError('Credential secret must not be empty');
    const slot = this.requireSlot(name);
    await this.runtime().commitCredential(slot.identity, slot.definition.name, secret, metadata);
  }
  private requireSlot(name: string): RegisteredCredentialSlot {
    const identity = namespace(this.ctx);
    const slot = this.slots.get(slotId(identity, validName(name)));
    if (!slot) throw new Error(`Credential Slot is not declared: ${name}`);
    return slot;
  }
  private runtime(): PluginDataRuntime {
    if (!this.dataRuntime) throw new Error('Plugin Credential Runtime is unavailable');
    return this.dataRuntime;
  }
}

export interface PluginAuthorizationMethod {
  readonly id: string;
  readonly label: string;
}
export interface PluginAuthorizationFlow {
  readonly slot: string;
  readonly label: string;
  readonly methods: readonly PluginAuthorizationMethod[];
  readonly run: (input: {
    readonly method: string;
    readonly signal: AbortSignal;
    readonly commit: (secret: string, metadata?: Readonly<Record<string, string>>) => Promise<void>;
  }) => Promise<'authorized' | 'cancelled'>;
}

/** Effect-owned authorization flows with one cancellable attempt per Secret Slot. */
export class PluginAuthorizationService extends Service {
  private readonly flows = new Map<string, PluginAuthorizationFlow>();
  private readonly active = new Map<string, AbortController>();
  constructor(ctx: Context, _credentials?: PluginCredentialService) {
    super(ctx, 'authorization');
  }
  register(flow: PluginAuthorizationFlow): () => Promise<void> {
    validateFlow(flow);
    const identity = namespace(this.ctx);
    const id = slotId(identity, flow.slot);
    return registerPluginContribution(
      this.ctx,
      `authorization.register(${JSON.stringify(flow.slot)})`,
      () => {
        if (this.flows.has(id))
          throw new Error(`Authorization Flow is already registered: ${flow.slot}`);
        this.flows.set(id, flow);
        return () => {
          this.active.get(id)?.abort(new Error('Authorization Flow disposed'));
          this.active.delete(id);
          this.flows.delete(id);
        };
      },
    );
  }
  async begin(
    slot: string,
    method?: string,
    signal?: AbortSignal,
  ): Promise<'authorized' | 'cancelled'> {
    const identity = namespace(this.ctx);
    const id = slotId(identity, validName(slot));
    const flow = this.flows.get(id);
    if (!flow) throw new Error(`Authorization Flow is unavailable: ${slot}`);
    if (this.active.has(id)) throw new Error(`Authorization is already in progress: ${slot}`);
    const selected = method ?? flow.methods[0]!.id;
    if (!flow.methods.some(({ id }) => id === selected))
      throw new Error(`Authorization method is unavailable: ${selected}`);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.active.set(id, controller);
    let committed = false;
    try {
      const outcome = await flow.run({
        method: selected,
        signal: controller.signal,
        commit: async (secret, metadata) => {
          await this.ctx.credentials[authorizationCommit](slot, secret, metadata);
          committed = true;
        },
      });
      if (outcome === 'authorized' && !committed)
        throw new Error('Authorization Flow returned authorized without committing a credential');
      return outcome;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }
  cancel(slot: string): void {
    const identity = namespace(this.ctx);
    this.active.get(slotId(identity, validName(slot)))?.abort(new Error('Authorization cancelled'));
  }
}

function namespace(ctx: Context): PluginDataNamespace {
  const { extensionId, scopeId } = pluginIdentity(ctx);
  return Object.freeze({ extensionId, scopeId });
}
function slotId(identity: PluginDataNamespace, name: string): string {
  return `${identity.scopeId}\0${identity.extensionId}\0${name}`;
}
function validName(value: string): string {
  if (!/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u.test(value))
    throw new TypeError(`Invalid plugin name: ${value}`);
  return value;
}
function validKey(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/u.test(value) || value.includes('..'))
    throw new TypeError(`Invalid plugin data key: ${value}`);
  return value;
}
function validPrefix(value: string): string {
  if (value === '') return value;
  return validKey(value);
}
function detached<T>(value: T): T {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Plugin data must be JSON-serializable');
  if (Buffer.byteLength(json, 'utf8') > 1024 * 1024)
    throw new TypeError('Plugin data value exceeds 1 MiB');
  return JSON.parse(json) as T;
}
function validateSettingDefinition(value: PluginSettingDefinition): void {
  validKey(value.key);
  if (!value.title.trim()) throw new TypeError('Plugin Setting title must not be empty');
}
function validateSlot(value: PluginCredentialSlot): void {
  validName(value.name);
  if (!value.label.trim()) throw new TypeError('Credential Slot label must not be empty');
}
function validateFlow(value: PluginAuthorizationFlow): void {
  validName(value.slot);
  if (!value.label.trim() || typeof value.run !== 'function' || value.methods.length === 0)
    throw new TypeError('Invalid Authorization Flow');
  const ids = value.methods.map(({ id }) => validName(id));
  if (new Set(ids).size !== ids.length || value.methods.some(({ label }) => !label.trim()))
    throw new TypeError('Invalid Authorization methods');
}
