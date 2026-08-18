export type ExtensionRuntimeContextKind = 'root' | 'scope' | 'plugin';
export type ExtensionRuntimeContextStatus = 'preparing' | 'active' | 'stopping' | 'stopped';

export type ExtensionRuntimeEffectDisposer = () => void | Promise<void>;

export interface ExtensionRuntimeContextDescriptor {
  readonly id: string;
  readonly kind: ExtensionRuntimeContextKind;
  readonly label: string;
  readonly status: ExtensionRuntimeContextStatus;
  readonly capabilityKeys: readonly string[];
  readonly effectLabels: readonly string[];
  readonly children: readonly ExtensionRuntimeContextDescriptor[];
}

export interface ExtensionRuntimeContextInput {
  readonly id: string;
  readonly kind: Exclude<ExtensionRuntimeContextKind, 'root'>;
  readonly label?: string;
  readonly replacementKey?: string;
  readonly status?: Extract<ExtensionRuntimeContextStatus, 'preparing' | 'active'>;
}

interface OwnedEffect {
  readonly label: string;
  readonly dispose: ExtensionRuntimeEffectDisposer;
}

interface CapabilityEntry {
  readonly owner: ExtensionRuntimeContext;
  readonly token: symbol;
  readonly value: unknown;
}

export class ExtensionRuntimeContextError extends Error {
  readonly name = 'ExtensionRuntimeContextError';
}

/**
 * One node in the live Extension runtime tree.
 *
 * Children, capabilities, and effects belong to this node and are released
 * together. Capabilities are published into the parent scope so sibling
 * plugins can depend on contracts instead of concrete plugin identities.
 */
export class ExtensionRuntimeContext {
  readonly #children = new Map<string, ExtensionRuntimeContext>();
  readonly #effects: OwnedEffect[] = [];
  readonly #capabilities = new Map<string, CapabilityEntry[]>();
  readonly #publishedCapabilities = new Map<string, symbol>();
  #status: ExtensionRuntimeContextStatus;
  #closeTask: Promise<void> | undefined;

  private constructor(
    readonly id: string,
    readonly kind: ExtensionRuntimeContextKind,
    readonly label: string,
    readonly parent?: ExtensionRuntimeContext,
    readonly replacementKey?: string,
    status: ExtensionRuntimeContextStatus = 'active',
  ) {
    validateContextIdentity(id, 'Context id');
    if (!label || label.length > 256)
      throw new ExtensionRuntimeContextError('Invalid Context label');
    this.#status = status;
  }

  static root(id = 'extensions'): ExtensionRuntimeContext {
    return new ExtensionRuntimeContext(id, 'root', id, undefined, undefined);
  }

  get status(): ExtensionRuntimeContextStatus {
    return this.#status;
  }

  fork(input: ExtensionRuntimeContextInput): ExtensionRuntimeContext {
    this.#assertMutable();
    if (this.#children.has(input.id)) {
      throw new ExtensionRuntimeContextError(`Context child already exists: ${input.id}`);
    }
    const child = new ExtensionRuntimeContext(
      input.id,
      input.kind,
      input.label ?? input.id,
      this,
      input.replacementKey,
      input.status ?? 'active',
    );
    this.#children.set(child.id, child);
    return child;
  }

  activate(): void {
    if (this.#status !== 'preparing') {
      throw new ExtensionRuntimeContextError(`Context cannot activate from ${this.#status}`);
    }
    this.#status = 'active';
  }

  own(label: string, dispose: ExtensionRuntimeEffectDisposer): void {
    this.#assertMutable();
    if (!label || label.length > 256 || typeof dispose !== 'function') {
      throw new ExtensionRuntimeContextError('Context effects require a label and disposer');
    }
    this.#effects.push({ label, dispose });
  }

  provide<T>(key: string, value: T): () => void {
    this.#assertMutable();
    validateCapabilityKey(key);
    const target = this.parent ?? this;
    const entries = target.#capabilities.get(key) ?? [];
    const existing = entries.at(-1);
    if (
      existing &&
      existing.owner !== this &&
      (!this.replacementKey || existing.owner.replacementKey !== this.replacementKey)
    ) {
      throw new ExtensionRuntimeContextError(
        `Capability ${key} is already provided by ${existing.owner.label}`,
      );
    }
    const token = Symbol(key);
    target.#capabilities.set(key, [
      ...entries.filter((entry) => entry.owner !== this),
      { owner: this, token, value },
    ]);
    this.#publishedCapabilities.set(key, token);
    const dispose = () => {
      if (this.#publishedCapabilities.get(key) !== token) return;
      this.#publishedCapabilities.delete(key);
      const remaining = (target.#capabilities.get(key) ?? []).filter(
        (entry) => entry.token !== token,
      );
      if (remaining.length > 0) target.#capabilities.set(key, remaining);
      else target.#capabilities.delete(key);
    };
    this.own(`capability:${key}`, dispose);
    return dispose;
  }

  has(key: string): boolean {
    return this.#resolveCapability(key) !== undefined;
  }

  require<T>(key: string): T {
    validateCapabilityKey(key);
    const entry = this.#resolveCapability(key);
    if (!entry)
      throw new ExtensionRuntimeContextError(`Required capability is unavailable: ${key}`);
    return entry.value as T;
  }

  inspect(): ExtensionRuntimeContextDescriptor {
    return Object.freeze({
      id: this.id,
      kind: this.kind,
      label: this.label,
      status: this.#status,
      capabilityKeys: Object.freeze(
        [...this.#capabilities.entries()]
          .filter(([, entries]) =>
            entries.some((entry) => entry.owner === this || entry.owner.parent === this),
          )
          .map(([key]) => key)
          .sort(compareString),
      ),
      effectLabels: Object.freeze(this.#effects.map(({ label }) => label)),
      children: Object.freeze(
        [...this.#children.values()]
          .sort((left, right) => compareString(left.id, right.id))
          .map((child) => child.inspect()),
      ),
    });
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close().catch((error: unknown) => {
      this.#closeTask = undefined;
      throw error;
    });
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    if (this.#status === 'stopped') return;
    this.#status = 'stopping';
    const failures: unknown[] = [];
    for (const child of [...this.#children.values()].reverse()) {
      try {
        await child.close();
      } catch (error) {
        failures.push(error);
      }
    }
    for (let index = this.#effects.length - 1; index >= 0; index -= 1) {
      const effect = this.#effects[index]!;
      try {
        await effect.dispose();
        this.#effects.splice(index, 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Unable to close Extension Context ${this.label}`);
    }
    if (this.parent) this.parent.#children.delete(this.id);
    this.#status = 'stopped';
  }

  #resolveCapability(key: string): CapabilityEntry | undefined {
    validateCapabilityKey(key);
    for (
      let context: ExtensionRuntimeContext | undefined = this;
      context;
      context = context.parent
    ) {
      const entry = context.#capabilities.get(key)?.at(-1);
      if (entry) return entry;
    }
    return undefined;
  }

  #assertMutable(): void {
    if (this.#status === 'stopping' || this.#status === 'stopped') {
      throw new ExtensionRuntimeContextError(`Context is ${this.#status}: ${this.label}`);
    }
  }
}

function validateContextIdentity(value: string, label: string): void {
  if (!value || value.length > 256 || /[\r\n\0]/u.test(value)) {
    throw new ExtensionRuntimeContextError(`${label} is invalid`);
  }
}

function validateCapabilityKey(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new ExtensionRuntimeContextError('Capability key is invalid');
  }
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
