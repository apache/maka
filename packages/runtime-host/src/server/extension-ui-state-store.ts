import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STATE_FILE_NAME = 'extension-ui-state-v2.json';
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KEYS = 256;

export type ExtensionUiStateValue =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionUiStateValue[]
  | { readonly [key: string]: ExtensionUiStateValue };

interface PersistedState {
  readonly schemaVersion: 1;
  readonly scopes: Readonly<Record<string, Readonly<Record<string, ExtensionUiStateValue>>>>;
}

/** Durable, root-private state owned by sandboxed UI Extensions. */
export class HostExtensionUiStateStore {
  readonly path: string | undefined;
  readonly #memory = new Map<string, Map<string, ExtensionUiStateValue>>();
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(controlDirectory?: string) {
    this.path = controlDirectory ? join(controlDirectory, STATE_FILE_NAME) : undefined;
  }

  async get(
    scopeId: string,
    entryId: string,
    key: string,
  ): Promise<{ found: boolean; value: ExtensionUiStateValue | null }> {
    await this.#load();
    const state = this.#memory.get(ownerKey(scopeId, entryId));
    return state?.has(key)
      ? { found: true, value: cloneValue(state.get(key)!) }
      : { found: false, value: null };
  }

  async set(
    scopeId: string,
    entryId: string,
    key: string,
    value: ExtensionUiStateValue,
  ): Promise<void> {
    validateKey(key);
    validateValue(value);
    await this.#mutate(async () => {
      let state = this.#memory.get(ownerKey(scopeId, entryId));
      if (!state) {
        state = new Map();
        this.#memory.set(ownerKey(scopeId, entryId), state);
      }
      if (!state.has(key) && state.size >= MAX_KEYS)
        throw new Error('UI Extension state key limit exceeded');
      state.set(key, cloneValue(value));
    });
  }

  async delete(scopeId: string, entryId: string, key: string): Promise<boolean> {
    validateKey(key);
    let deleted = false;
    await this.#mutate(async () => {
      const owner = ownerKey(scopeId, entryId);
      const state = this.#memory.get(owner);
      deleted = state?.delete(key) ?? false;
      if (state?.size === 0) this.#memory.delete(owner);
    });
    return deleted;
  }

  async clear(scopeId: string, entryId: string): Promise<void> {
    await this.#mutate(async () => {
      this.#memory.delete(ownerKey(scopeId, entryId));
    });
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(async () => {
      await this.#load();
      await operation();
      await this.#persist();
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.path) return;
    let encoded: Buffer;
    try {
      encoded = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (encoded.byteLength > MAX_STATE_BYTES)
      throw new Error('UI Extension state exceeds its size limit');
    const decoded = JSON.parse(encoded.toString('utf8')) as PersistedState;
    if (decoded.schemaVersion !== 1 || !decoded.scopes || typeof decoded.scopes !== 'object') {
      throw new Error('UI Extension state is invalid');
    }
    for (const [owner, entries] of Object.entries(decoded.scopes)) {
      const state = new Map<string, ExtensionUiStateValue>();
      for (const [key, value] of Object.entries(entries)) {
        validateKey(key);
        validateValue(value);
        state.set(key, cloneValue(value));
      }
      this.#memory.set(owner, state);
    }
  }

  async #persist(): Promise<void> {
    if (!this.path) return;
    const scopes = Object.fromEntries(
      [...this.#memory.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([owner, entries]) => [
          owner,
          Object.fromEntries(
            [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)),
          ),
        ]),
    );
    const encoded = `${JSON.stringify({ schemaVersion: 1, scopes })}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES)
      throw new Error('UI Extension state exceeds its size limit');
    const directory = dirname(this.path);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function ownerKey(scopeId: string, entryId: string): string {
  return `${scopeId}\u0000${entryId}`;
}

function validateKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key))
    throw new Error('UI Extension state key is invalid');
}

function validateValue(value: unknown): asserts value is ExtensionUiStateValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) {
    throw new Error('UI Extension state value is invalid or too large');
  }
  JSON.parse(encoded);
}

function cloneValue<T extends ExtensionUiStateValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
