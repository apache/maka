import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isCanonicalExtensionId, isCanonicalExtensionScopeId } from '@maka/runtime/plugin-runtime';
import type { ExtensionConfigurationScalar } from './extension-package-manifest.js';

const FILE_NAME = 'plugin-composition-v2.json';
const MAX_BYTES = 2 * 1024 * 1024;

export interface PersistedPluginEntry {
  readonly id: string;
  readonly packageId?: string;
  readonly disabled: boolean;
  readonly config: Readonly<Record<string, ExtensionConfigurationScalar>>;
  readonly inject?: readonly string[] | Readonly<Record<string, unknown>>;
  readonly isolate?: Readonly<Record<string, true | string>>;
  readonly intercept?: Readonly<Record<string, unknown>>;
  readonly children?: readonly PersistedPluginEntry[];
  readonly error?: string | null;
}

export interface PersistedPluginComposition {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly roots: {
    readonly profile: readonly PersistedPluginEntry[];
    readonly desktopUi: readonly PersistedPluginEntry[];
    readonly sessions: Readonly<Record<string, readonly PersistedPluginEntry[]>>;
  };
}

export class HostPluginCompositionStoreError extends Error {
  readonly name = 'HostPluginCompositionStoreError';

  constructor(
    readonly code: 'persistence_failed' | 'invalid_state' | 'commit_outcome_unknown',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class HostPluginCompositionStore {
  readonly path: string;

  constructor(controlDirectory: string) {
    this.path = join(controlDirectory, FILE_NAME);
  }

  async read(): Promise<PersistedPluginComposition | undefined> {
    let encoded: Buffer;
    try {
      encoded = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw persistence('Unable to read Plugin Composition', error);
    }
    if (encoded.byteLength > MAX_BYTES) throw invalid('Plugin Composition exceeds its size limit');
    try {
      return decode(JSON.parse(encoded.toString('utf8')));
    } catch (error) {
      if (error instanceof HostPluginCompositionStoreError) throw error;
      throw invalid('Plugin Composition is invalid JSON', error);
    }
  }

  async replace(snapshot: PersistedPluginComposition): Promise<void> {
    const normalized = decode(snapshot);
    const encoded = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
    if (encoded.byteLength > MAX_BYTES) throw invalid('Plugin Composition exceeds its size limit');
    const directory = dirname(this.path);
    const temporary = join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      throw persistence('Unable to persist Plugin Composition', error);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function decode(value: unknown): PersistedPluginComposition {
  const root = record(value, 'Plugin Composition');
  exact(root, ['schemaVersion', 'generation', 'roots']);
  if (
    root.schemaVersion !== 1 ||
    !Number.isSafeInteger(root.generation) ||
    (root.generation as number) < 0
  ) {
    throw invalid('Plugin Composition header is invalid');
  }
  const roots = record(root.roots, 'Plugin Composition roots');
  exact(roots, ['profile', 'desktopUi', 'sessions']);
  const sessions = record(roots.sessions, 'Plugin Composition sessions');
  const decodedSessions: Record<string, readonly PersistedPluginEntry[]> = {};
  for (const [scopeId, entries] of Object.entries(sessions)) {
    if (!isCanonicalExtensionScopeId(scopeId)) throw invalid(`Invalid Session scope: ${scopeId}`);
    decodedSessions[scopeId] = decodeEntries(entries, `sessions.${scopeId}`);
  }
  const profile = decodeEntries(roots.profile, 'profile');
  const desktopUi = decodeEntries(roots.desktopUi, 'desktopUi');
  const all = [
    ...walk(profile),
    ...walk(desktopUi),
    ...Object.values(decodedSessions).flatMap(walk),
  ];
  const ids = new Set<string>();
  for (const entry of all) {
    if (ids.has(entry.id)) throw invalid(`Plugin entry id is repeated: ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({
    schemaVersion: 1,
    generation: root.generation as number,
    roots: Object.freeze({
      profile,
      desktopUi,
      sessions: Object.freeze(decodedSessions),
    }),
  });
}

function decodeEntries(value: unknown, label: string): readonly PersistedPluginEntry[] {
  if (!Array.isArray(value) || value.length > 256) throw invalid(`${label} entries are invalid`);
  return Object.freeze(value.map((item, index) => decodeEntry(item, `${label}[${index}]`)));
}

function decodeEntry(value: unknown, label: string): PersistedPluginEntry {
  const entry = record(value, label);
  exactOptional(
    entry,
    ['id', 'disabled', 'config'],
    ['packageId', 'inject', 'isolate', 'intercept', 'children', 'error'],
  );
  if (!isCanonicalExtensionScopeId(entry.id)) throw invalid(`${label}.id is invalid`);
  const group = entry.packageId === undefined;
  if (!group && !isCanonicalExtensionId(entry.packageId))
    throw invalid(`${label}.packageId is invalid`);
  if (typeof entry.disabled !== 'boolean') throw invalid(`${label}.disabled is invalid`);
  const config = scalarRecord(entry.config, `${label}.config`);
  const error =
    entry.error === undefined
      ? undefined
      : entry.error === null
        ? null
        : text(entry.error, `${label}.error`, 4096);
  const inject = decodeInject(entry.inject, `${label}.inject`);
  const isolate = decodeIsolate(entry.isolate, `${label}.isolate`);
  const intercept = decodeJsonRecord(entry.intercept, `${label}.intercept`);
  const children =
    entry.children === undefined ? undefined : decodeEntries(entry.children, `${label}.children`);
  return Object.freeze({
    id: entry.id as string,
    ...(group ? {} : { packageId: entry.packageId as string }),
    disabled: entry.disabled,
    config,
    ...(inject === undefined ? {} : { inject }),
    ...(isolate === undefined ? {} : { isolate }),
    ...(intercept === undefined ? {} : { intercept }),
    ...(children === undefined ? {} : { children }),
    ...(error === undefined ? {} : { error }),
  });
}

function decodeInject(
  value: unknown,
  label: string,
): readonly string[] | Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length > 64 || value.some((item) => typeof item !== 'string' || !item)) {
      throw invalid(`${label} is invalid`);
    }
    return Object.freeze([...value]);
  }
  return decodeJsonRecord(value, label);
}

function decodeIsolate(
  value: unknown,
  label: string,
): Readonly<Record<string, true | string>> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, label);
  const output: Record<string, true | string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (item !== true && (typeof item !== 'string' || !item))
      throw invalid(`${label}.${key} is invalid`);
    output[key] = item;
  }
  return Object.freeze(output);
}

function decodeJsonRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, label);
  let encoded: string;
  try {
    encoded = JSON.stringify(source);
  } catch (error) {
    throw invalid(`${label} is not JSON`, error);
  }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024)
    throw invalid(`${label} exceeds its size limit`);
  return Object.freeze(structuredClone(source));
}

function walk(entries: readonly PersistedPluginEntry[]): readonly PersistedPluginEntry[] {
  return entries.flatMap((entry) => [entry, ...walk(entry.children ?? [])]);
}

function scalarRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, ExtensionConfigurationScalar>> {
  const source = record(value, label);
  const output: Record<string, ExtensionConfigurationScalar> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(key)) throw invalid(`${label} key is invalid`);
    if (
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      !(typeof item === 'number' && Number.isFinite(item))
    ) {
      throw invalid(`${label}.${key} is invalid`);
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw invalid('Plugin Composition fields are invalid');
  }
}

function exactOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalid('Plugin Composition fields are invalid');
  }
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\r\n\0]/u.test(value)
  ) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function invalid(message: string, cause?: unknown): HostPluginCompositionStoreError {
  return new HostPluginCompositionStoreError('invalid_state', message, { cause });
}

function persistence(message: string, cause?: unknown): HostPluginCompositionStoreError {
  return new HostPluginCompositionStoreError('persistence_failed', message, { cause });
}
