import type { Context, FiberState, Plugin } from './plugin-kernel.js';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

export type MakaPluginRootId = 'profile' | 'desktop-ui' | `session:${string}`;

export interface MakaPluginPackage {
  readonly packageId: string;
  readonly revision: string;
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
  readonly revision?: string;
  readonly config?: unknown;
  readonly disabled?: boolean;
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>>;
  readonly isolate?: Readonly<Record<string, true | string>>;
  readonly intercept?: Readonly<Record<string, unknown>>;
  readonly children?: readonly MakaCompositionEntry[];
}

export interface MakaCompositionSnapshot {
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
  readonly revision?: string;
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
  readonly revision: string;
  readonly config?: unknown;
}

export interface MakaPluginMountInspection {
  readonly entryId: string;
  readonly rootId: string;
  readonly packageId: string;
  readonly desiredRevision: string;
  readonly enabled: boolean;
  readonly status: MakaCompositionEntryStatus;
  readonly current?: { readonly revision: string; readonly generation: number };
  readonly waitingFor: readonly string[];
  readonly pendingCleanupEffects: number;
  readonly diagnostic?: { readonly message: string };
}

export interface MakaRuntimeCompositionEntry {
  readonly entryId: string;
  readonly packageId: string;
  readonly revision: string;
  readonly generation: number;
  readonly contributions: readonly MakaPluginContribution[];
}

export interface MakaRuntimeCompositionSnapshot {
  readonly schemaVersion: 1;
  readonly rootId: string;
  readonly digest: `sha256:${string}`;
  readonly entries: readonly MakaRuntimeCompositionEntry[];
}

export interface MakaPluginMetadata {
  readonly rootId: MakaPluginRootId;
  readonly entryId: string;
  readonly packageId: string;
  readonly revision: string;
  readonly generation: number;
}

export interface MakaContributionIdentity {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
}

export interface MakaContributionContext extends MakaContributionIdentity {
  readonly signal: AbortSignal;
  readonly runtimeContext: Context;
  ownEffect(label: string, dispose: () => void | Promise<void>): void;
  dependency<T = unknown>(packageId: string): T;
  dependencyRevision(packageId: string): string;
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
  if (typeof pkg.revision !== 'string' || !pkg.revision || /[\r\n\0]/u.test(pkg.revision)) {
    throw new MakaPluginRuntimeError('invalid_package', 'Plugin revision is invalid');
  }
  if (!pkg.host && !pkg.client) {
    throw new MakaPluginRuntimeError(
      'invalid_package',
      `Plugin package ${pkg.packageId}@${pkg.revision} has no host or client plugin`,
    );
  }
}

export function validateCompositionEntry(entry: MakaCompositionEntry): void {
  validatePluginId(entry.id, 'entry id');
  const group = entry.packageId === undefined && entry.revision === undefined;
  if ((entry.packageId === undefined) !== (entry.revision === undefined)) {
    throw new MakaPluginRuntimeError(
      'invalid_entry',
      `Composition entry ${entry.id} must declare both packageId and revision`,
    );
  }
  if (!group) {
    validatePluginId(entry.packageId!, 'packageId');
    if (!entry.revision || /[\r\n\0]/u.test(entry.revision)) {
      throw new MakaPluginRuntimeError(
        'invalid_entry',
        `Entry ${entry.id} has an invalid revision`,
      );
    }
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

export function pluginPackageKey(packageId: string, revision: string): string {
  return `${packageId}\0${revision}`;
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
    bindingId: metadata.entryId,
    scopeId: metadata.rootId,
    extensionId: metadata.packageId,
    revision: metadata.revision,
  });
}

export function ownPluginEffect(
  ctx: Context,
  label: string,
  dispose: () => void | Promise<void>,
): void {
  ctx.effect(() => dispose, label);
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
  const dispose = register();
  ownPluginEffect(ctx, label, dispose);
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
      const dispose = register();
      ownPluginEffect(owner, label, dispose);
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
    const registered: Array<() => void | Promise<void>> = [];
    try {
      for (const item of this.#registrations) {
        const dispose = item.register();
        registered.push(dispose);
        ownPluginEffect(item.owner, item.label, dispose);
      }
      this.#state = 'committed';
      this.#registrations.length = 0;
    } catch (error) {
      for (const dispose of registered.reverse()) await dispose();
      this.#state = 'rolled_back';
      this.#registrations.length = 0;
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
