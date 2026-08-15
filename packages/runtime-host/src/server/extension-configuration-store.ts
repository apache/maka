import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExtensionConfigurationScalar } from './extension-package-manifest.js';

const FILE_NAME = 'extension-configuration-v1.json';
const MAX_BYTES = 1024 * 1024;

interface ConfigurationDocument {
  readonly schemaVersion: 1;
  readonly bindings: Readonly<
    Record<string, Readonly<Record<string, ExtensionConfigurationScalar>>>
  >;
}

/** Root-private configuration keyed by Binding so different scopes may configure one package independently. */
export class HostExtensionConfigurationStore {
  readonly path: string;

  constructor(controlDirectory: string) {
    this.path = join(controlDirectory, FILE_NAME);
  }

  async read(): Promise<
    ReadonlyMap<string, Readonly<Record<string, ExtensionConfigurationScalar>>>
  > {
    let encoded: Buffer;
    try {
      encoded = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw new Error('Unable to read Extension configuration', { cause: error });
    }
    if (encoded.byteLength > MAX_BYTES)
      throw new Error('Extension configuration store is too large');
    const document = decode(JSON.parse(encoded.toString('utf8')));
    return new Map(Object.entries(document.bindings));
  }

  async replace(
    bindings: ReadonlyMap<string, Readonly<Record<string, ExtensionConfigurationScalar>>>,
  ): Promise<void> {
    const document = decode({
      schemaVersion: 1,
      bindings: Object.fromEntries([...bindings].sort()),
    });
    const encoded = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
    if (encoded.byteLength > MAX_BYTES)
      throw new Error('Extension configuration store is too large');
    const directory = dirname(this.path);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
    } catch (error) {
      throw new Error('Unable to persist Extension configuration', { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function decode(value: unknown): ConfigurationDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Extension configuration document is invalid');
  const document = value as Record<string, unknown>;
  if (
    Object.keys(document).sort().join() !== 'bindings,schemaVersion' ||
    document.schemaVersion !== 1 ||
    !document.bindings ||
    typeof document.bindings !== 'object' ||
    Array.isArray(document.bindings)
  ) {
    throw new Error('Extension configuration document fields are invalid');
  }
  const bindings: Record<string, Readonly<Record<string, ExtensionConfigurationScalar>>> = {};
  for (const [bindingId, configuration] of Object.entries(
    document.bindings as Record<string, unknown>,
  )) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(bindingId) ||
      !configuration ||
      typeof configuration !== 'object' ||
      Array.isArray(configuration)
    ) {
      throw new Error('Extension configuration binding is invalid');
    }
    const values: Record<string, ExtensionConfigurationScalar> = {};
    for (const [key, value] of Object.entries(configuration as Record<string, unknown>)) {
      if (
        !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(key) ||
        (typeof value !== 'string' &&
          typeof value !== 'boolean' &&
          !(typeof value === 'number' && Number.isFinite(value)))
      ) {
        throw new Error('Extension configuration value is invalid');
      }
      values[key] = value;
    }
    bindings[bindingId] = Object.freeze(values);
  }
  return Object.freeze({ schemaVersion: 1, bindings: Object.freeze(bindings) });
}
