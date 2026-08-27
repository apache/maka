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

import type { Context, FiberState, Plugin } from './plugin-kernel.js';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

export type MakaPluginRootId = 'profile' | 'desktop-ui' | `session:${string}`;

export interface MakaPluginPackage {
  readonly packageId: string;
  readonly host?: Plugin;
  readonly client?: Plugin;
  readonly contributions?: readonly MakaPluginContribution[];
}

export interface MakaPluginContribution {
  readonly id: string;
  readonly kind: 'tool' | 'ui' | 'hook' | 'service' | 'timer' | string;
}

export interface MakaCompositionEntry {
  readonly id: string;
  readonly packageId?: string;
  readonly config?: unknown;
  readonly disabled?: boolean;
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>>;
  readonly isolate?: Readonly<Record<string, true | string>>;
  readonly intercept?: Readonly<Record<string, unknown>>;
  readonly children?: readonly MakaCompositionEntry[];
}

export interface MakaCompositionState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly roots: {
    readonly profile: readonly MakaCompositionEntry[];
    readonly desktopUi: readonly MakaCompositionEntry[];
    readonly sessions: Readonly<Record<string, readonly MakaCompositionEntry[]>>;
  };
}

export type MakaCompositionOperation =
  | {
      readonly type: 'insert';
      readonly rootId?: MakaPluginRootId;
      readonly parentId?: string;
      readonly entry: MakaCompositionEntry;
      readonly position?: number;
    }
  | {
      readonly type: 'update';
      readonly entryId: string;
      readonly patch: Partial<Omit<MakaCompositionEntry, 'id' | 'children'>>;
    }
  | {
      readonly type: 'move';
      readonly entryId: string;
      readonly parentId?: string;
      readonly position?: number;
    }
  | { readonly type: 'remove'; readonly entryId: string };

export interface MakaCompositionApplyInput {
  readonly baseGeneration?: number;
  readonly operations: readonly MakaCompositionOperation[];
}

/**
 * Applies Entry Tree operations to the desired-state value without activating
 * Plugin code. Runtime Host uses this reducer to durably commit desired state
 * before asking the live Composition Loader to converge.
 */
export function applyCompositionState(
  state: MakaCompositionState,
  input: MakaCompositionApplyInput,
): MakaCompositionState {
  if (state.schemaVersion !== 1) {
    throw new MakaPluginRuntimeError('invalid_entry', 'Unsupported composition state');
  }
  if (input.baseGeneration !== undefined && input.baseGeneration !== state.generation) {
    throw new MakaPluginRuntimeError(
      'invalid_entry',
      `Composition generation changed from ${input.baseGeneration} to ${state.generation}`,
    );
  }
  if (input.operations.length === 0) return state;
  if (state.generation >= Number.MAX_SAFE_INTEGER) {
    throw new MakaPluginRuntimeError('invalid_entry', 'Composition generation is exhausted');
  }

  interface MutableLocation {
    entry: MakaCompositionEntry;
    parent?: MutableLocation;
    readonly rootId: MakaPluginRootId;
    siblings: MakaCompositionEntry[];
  }

  const profile = state.roots.profile.map(cloneCompositionEntry);
  const desktopUi = state.roots.desktopUi.map(cloneCompositionEntry);
  const sessions = Object.fromEntries(
    Object.entries(state.roots.sessions).map(([scopeId, entries]) => [
      scopeId,
      entries.map(cloneCompositionEntry),
    ]),
  ) as Record<string, MakaCompositionEntry[]>;
  const locations = new Map<string, MutableLocation>();

  const index = (
    entries: MakaCompositionEntry[],
    rootId: MakaPluginRootId,
    parent?: MutableLocation,
  ): void => {
    validatePluginRootId(rootId);
    for (const entry of entries) {
      validateCompositionEntry(entry);
      if (locations.has(entry.id)) {
        throw new MakaPluginRuntimeError(
          'entry_exists',
          `Composition entry already exists: ${entry.id}`,
        );
      }
      const location: MutableLocation = { entry, parent, rootId, siblings: entries };
      locations.set(entry.id, location);
      index(entry.children as MakaCompositionEntry[], rootId, location);
    }
  };
  index(profile, 'profile');
  index(desktopUi, 'desktop-ui');
  for (const [scopeId, entries] of Object.entries(sessions)) {
    index(entries, `session:${scopeId}`);
  }

  const requireLocation = (entryId: string): MutableLocation => {
    const location = locations.get(entryId);
    if (!location) {
      throw new MakaPluginRuntimeError(
        'entry_not_found',
        `Composition entry not found: ${entryId}`,
      );
    }
    return location;
  };
  const rootEntries = (rootId: MakaPluginRootId): MakaCompositionEntry[] => {
    validatePluginRootId(rootId);
    if (rootId === 'profile') return profile;
    if (rootId === 'desktop-ui') return desktopUi;
    const scopeId = rootId.slice('session:'.length);
    if (!Object.hasOwn(sessions, scopeId)) {
      Object.defineProperty(sessions, scopeId, {
        value: [],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return sessions[scopeId]!;
  };
  const unindex = (entry: MakaCompositionEntry): void => {
    locations.delete(entry.id);
    for (const child of entry.children ?? []) unindex(child);
  };
  const indexInserted = (
    entry: MakaCompositionEntry,
    rootId: MakaPluginRootId,
    siblings: MakaCompositionEntry[],
    parent?: MutableLocation,
  ): void => {
    if (locations.has(entry.id)) {
      throw new MakaPluginRuntimeError(
        'entry_exists',
        `Composition entry already exists: ${entry.id}`,
      );
    }
    const location: MutableLocation = { entry, parent, rootId, siblings };
    locations.set(entry.id, location);
    for (const child of entry.children ?? []) {
      indexInserted(child, rootId, entry.children as MakaCompositionEntry[], location);
    }
  };

  for (const operation of input.operations) {
    switch (operation.type) {
      case 'insert': {
        const parent = operation.parentId ? requireLocation(operation.parentId) : undefined;
        const rootId = operation.rootId ?? parent?.rootId ?? 'profile';
        validatePluginRootId(rootId);
        if (parent && parent.rootId !== rootId) {
          throw new MakaPluginRuntimeError(
            'invalid_entry',
            'Composition entries cannot move between roots',
          );
        }
        const entry = cloneCompositionEntry(operation.entry);
        validateCompositionEntry(entry);
        const subtreeIds = new Set<string>();
        for (const item of walkCompositionEntry(entry)) {
          if (subtreeIds.has(item.id) || locations.has(item.id)) {
            throw new MakaPluginRuntimeError(
              'entry_exists',
              `Composition entry already exists: ${item.id}`,
            );
          }
          subtreeIds.add(item.id);
        }
        const siblings = parent
          ? (parent.entry.children as MakaCompositionEntry[])
          : rootEntries(rootId);
        siblings.splice(Math.min(operation.position ?? Infinity, siblings.length), 0, entry);
        indexInserted(entry, rootId, siblings, parent);
        break;
      }
      case 'update': {
        const location = requireLocation(operation.entryId);
        const next: MakaCompositionEntry = {
          ...location.entry,
          ...operation.patch,
          id: location.entry.id,
          children: location.entry.children,
        };
        validateCompositionEntry(next);
        const position = location.siblings.indexOf(location.entry);
        location.siblings[position] = next;
        location.entry = next;
        break;
      }
      case 'move': {
        const location = requireLocation(operation.entryId);
        const parent = operation.parentId ? requireLocation(operation.parentId) : undefined;
        if (parent && parent.rootId !== location.rootId) {
          throw new MakaPluginRuntimeError(
            'invalid_entry',
            'Composition entries cannot move between roots',
          );
        }
        for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor === location) {
            throw new MakaPluginRuntimeError(
              'dependency_cycle',
              `Entry ${operation.entryId} cannot contain itself`,
            );
          }
        }
        location.siblings.splice(location.siblings.indexOf(location.entry), 1);
        const siblings = parent
          ? (parent.entry.children as MakaCompositionEntry[])
          : rootEntries(location.rootId);
        siblings.splice(
          Math.min(operation.position ?? Infinity, siblings.length),
          0,
          location.entry,
        );
        location.parent = parent;
        location.siblings = siblings;
        break;
      }
      case 'remove': {
        const location = requireLocation(operation.entryId);
        location.siblings.splice(location.siblings.indexOf(location.entry), 1);
        unindex(location.entry);
        break;
      }
    }
  }

  return freezeCompositionState({
    schemaVersion: 1,
    generation: state.generation + 1,
    roots: { profile, desktopUi, sessions },
  });
}

export type MakaCompositionEntryStatus =
  | 'disabled'
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | 'disposed';

export interface MakaCompositionEntryInspection {
  readonly id: string;
  readonly rootId: MakaPluginRootId;
  readonly parentId?: string;
  readonly packageId?: string;
  readonly config?: unknown;
  readonly disabled: boolean;
  readonly status: MakaCompositionEntryStatus;
  readonly generation?: number;
  readonly waitingFor: readonly string[];
  readonly effects: readonly string[];
  readonly children: readonly MakaCompositionEntryInspection[];
  readonly diagnostic?: string;
}

export interface MakaPluginMountInput {
  readonly entryId: string;
  readonly rootId: string;
  readonly packageId: string;
  readonly config?: unknown;
}

export interface MakaPluginMountInspection {
  readonly entryId: string;
  readonly rootId: string;
  readonly packageId: string;
  readonly enabled: boolean;
  readonly status: MakaCompositionEntryStatus;
  readonly current?: { readonly generation: number };
  readonly waitingFor: readonly string[];
  readonly pendingCleanupEffects: number;
  readonly diagnostic?: { readonly message: string };
}

export interface MakaPluginMetadata {
  readonly rootId: MakaPluginRootId;
  readonly entryId: string;
  readonly packageId: string;
  readonly generation: number;
}

export interface MakaContributionIdentity {
  readonly entryId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly generation: number;
}

export interface MakaContributionContext extends MakaContributionIdentity {
  readonly signal: AbortSignal;
  readonly runtimeContext: Context;
  ownEffect(label: string, dispose: () => void | Promise<void>): void;
  dependency<T = unknown>(packageId: string): T;
}

export interface MakaPluginTransaction {
  stage(label: string, register: () => () => void | Promise<void>, owner?: Context): void;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

declare module './plugin-kernel.js' {
  interface Context {
    maka?: MakaPluginMetadata;
    makaTransaction?: MakaPluginTransaction;
  }
}

export class MakaPluginRuntimeError extends Error {
  readonly name = 'MakaPluginRuntimeError';

  constructor(
    readonly code:
      | 'invalid_package'
      | 'package_exists'
      | 'package_not_found'
      | 'package_in_use'
      | 'invalid_entry'
      | 'entry_exists'
      | 'entry_not_found'
      | 'dependency_cycle'
      | 'activation_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function validatePluginPackage(pkg: MakaPluginPackage): void {
  validatePluginId(pkg.packageId, 'packageId');
  if (!pkg.host && !pkg.client) {
    throw new MakaPluginRuntimeError(
      'invalid_package',
      `Plugin package ${pkg.packageId} has no host or client plugin`,
    );
  }
  if (!Array.isArray(pkg.contributions ?? []) || (pkg.contributions?.length ?? 0) > 1024) {
    throw new MakaPluginRuntimeError(
      'invalid_package',
      `Plugin package ${pkg.packageId} has invalid contributions`,
    );
  }
  const contributions = new Set<string>();
  for (const contribution of pkg.contributions ?? []) {
    if (
      !contribution ||
      typeof contribution !== 'object' ||
      typeof contribution.id !== 'string' ||
      contribution.id.length === 0 ||
      contribution.id.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(contribution.id) ||
      typeof contribution.kind !== 'string' ||
      contribution.kind.length === 0 ||
      contribution.kind.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(contribution.kind)
    ) {
      throw new MakaPluginRuntimeError(
        'invalid_package',
        `Plugin package ${pkg.packageId} has an invalid contribution`,
      );
    }
    const identity = `${contribution.kind}\0${contribution.id}`;
    if (contributions.has(identity)) {
      throw new MakaPluginRuntimeError(
        'invalid_package',
        `Plugin package ${pkg.packageId} repeats contribution ${contribution.kind}:${contribution.id}`,
      );
    }
    contributions.add(identity);
  }
}

export function validateCompositionEntry(entry: MakaCompositionEntry): void {
  validatePluginId(entry.id, 'entry id');
  if (entry.packageId !== undefined) {
    validatePluginId(entry.packageId!, 'packageId');
  }
  for (const key of Object.keys(entry.isolate ?? {})) validateServiceName(key);
  for (const key of Object.keys(entry.intercept ?? {})) validateServiceName(key);
  for (const dependency of Array.isArray(entry.inject)
    ? entry.inject
    : Object.keys(entry.inject ?? {})) {
    validateServiceName(dependency);
  }
  const childIds = new Set<string>();
  for (const child of entry.children ?? []) {
    validateCompositionEntry(child);
    if (childIds.has(child.id)) {
      throw new MakaPluginRuntimeError(
        'entry_exists',
        `Entry ${entry.id} repeats child ${child.id}`,
      );
    }
    childIds.add(child.id);
  }
}

export function validatePluginRootId(rootId: string): asserts rootId is MakaPluginRootId {
  if (
    rootId !== 'profile' &&
    rootId !== 'desktop-ui' &&
    !(rootId.startsWith('session:') && rootId.length > 'session:'.length)
  ) {
    throw new MakaPluginRuntimeError('invalid_entry', `Invalid composition root: ${rootId}`);
  }
}

export function pluginIdentity(ctx: Context): MakaContributionIdentity {
  const metadata = ctx.maka;
  if (!metadata) {
    throw new MakaPluginRuntimeError(
      'activation_failed',
      'Contribution registration requires a composition entry Context',
    );
  }
  return Object.freeze({
    entryId: metadata.entryId,
    scopeId: metadata.rootId,
    extensionId: metadata.packageId,
    generation: metadata.generation,
  });
}

export function ownPluginEffect(
  ctx: Context,
  label: string,
  dispose: () => void | Promise<void>,
): void {
  attachPluginEffect(ctx, label, dispose);
}

function attachPluginEffect(
  ctx: Context,
  label: string,
  dispose: () => void | Promise<void>,
): () => Promise<void> {
  return ctx.effect(() => dispose, label);
}

function registerPluginEffect(
  ctx: Context,
  label: string,
  register: () => () => void | Promise<void>,
): () => Promise<void> {
  let contributionDispose: (() => void | Promise<void>) | undefined;
  const release = ctx.effect(() => () => contributionDispose?.(), label);
  try {
    contributionDispose = register();
    return release;
  } catch (error) {
    void release().catch(() => undefined);
    throw error;
  }
}

export function registerPluginContribution(
  ctx: Context,
  label: string,
  register: () => () => void | Promise<void>,
): void {
  if (ctx.makaTransaction) {
    ctx.makaTransaction.stage(label, register, ctx);
    return;
  }
  registerPluginEffect(ctx, label, register);
}

export class MakaPluginTransactionBuffer implements MakaPluginTransaction {
  readonly #registrations: Array<{
    readonly label: string;
    readonly register: () => () => void | Promise<void>;
    readonly owner: Context;
  }> = [];
  #state: 'staging' | 'committed' | 'rolled_back' = 'staging';

  constructor(private readonly context: Context) {}

  stage(label: string, register: () => () => void | Promise<void>, owner = this.context): void {
    if (this.#state === 'committed') {
      registerPluginEffect(owner, label, register);
      return;
    }
    if (this.#state === 'rolled_back') {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        `Cannot stage contribution after transaction is ${this.#state}`,
      );
    }
    this.#registrations.push({ label, register, owner });
  }

  async commit(): Promise<void> {
    if (this.#state === 'committed') return;
    if (this.#state === 'rolled_back') {
      throw new MakaPluginRuntimeError(
        'activation_failed',
        'Cannot commit a rolled back transaction',
      );
    }
    const registered: Array<() => Promise<void>> = [];
    try {
      for (const item of this.#registrations) {
        registered.push(registerPluginEffect(item.owner, item.label, item.register));
      }
      this.#state = 'committed';
      this.#registrations.length = 0;
    } catch (error) {
      this.#state = 'rolled_back';
      this.#registrations.length = 0;
      const cleanupErrors: unknown[] = [];
      for (const dispose of registered.reverse()) {
        try {
          await dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'Plugin transaction commit and rollback failed',
        );
      }
      throw error;
    }
  }

  rollback(): void {
    if (this.#state !== 'staging') return;
    this.#state = 'rolled_back';
    this.#registrations.length = 0;
  }
}

export function fiberStateName(state: FiberState): MakaCompositionEntryStatus {
  return ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'][
    state
  ] as MakaCompositionEntryStatus;
}

export function isCanonicalPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && ID_PATTERN.test(value);
}

export const isCanonicalExtensionId = isCanonicalPluginId;

function cloneCompositionEntry(entry: MakaCompositionEntry): MakaCompositionEntry {
  return {
    ...entry,
    ...(entry.inject && !Array.isArray(entry.inject)
      ? { inject: { ...entry.inject } }
      : entry.inject
        ? { inject: [...entry.inject] }
        : {}),
    ...(entry.isolate ? { isolate: { ...entry.isolate } } : {}),
    ...(entry.intercept ? { intercept: { ...entry.intercept } } : {}),
    children: (entry.children ?? []).map(cloneCompositionEntry),
  };
}

function* walkCompositionEntry(entry: MakaCompositionEntry): Generator<MakaCompositionEntry> {
  yield entry;
  for (const child of entry.children ?? []) yield* walkCompositionEntry(child);
}

function freezeCompositionState(state: MakaCompositionState): MakaCompositionState {
  const freezeEntry = (entry: MakaCompositionEntry): MakaCompositionEntry =>
    Object.freeze({
      ...entry,
      ...(entry.inject && !Array.isArray(entry.inject)
        ? { inject: Object.freeze({ ...entry.inject }) }
        : entry.inject
          ? { inject: Object.freeze([...entry.inject]) }
          : {}),
      ...(entry.isolate ? { isolate: Object.freeze({ ...entry.isolate }) } : {}),
      ...(entry.intercept ? { intercept: Object.freeze({ ...entry.intercept }) } : {}),
      children: Object.freeze((entry.children ?? []).map(freezeEntry)),
    });
  return Object.freeze({
    schemaVersion: 1,
    generation: state.generation,
    roots: Object.freeze({
      profile: Object.freeze(state.roots.profile.map(freezeEntry)),
      desktopUi: Object.freeze(state.roots.desktopUi.map(freezeEntry)),
      sessions: Object.freeze(
        Object.fromEntries(
          Object.entries(state.roots.sessions).map(([scopeId, entries]) => [
            scopeId,
            Object.freeze(entries.map(freezeEntry)),
          ]),
        ),
      ),
    }),
  });
}

export function isCanonicalExtensionScopeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function validatePluginId(value: unknown, label: string): asserts value is string {
  if (!isCanonicalPluginId(value)) {
    throw new MakaPluginRuntimeError('invalid_entry', `Invalid ${label}`);
  }
}

function validateServiceName(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new MakaPluginRuntimeError('invalid_entry', `Invalid service name: ${value}`);
  }
}
