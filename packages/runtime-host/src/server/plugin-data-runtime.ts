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

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PluginDataMutation,
  PluginDataNamespace,
  PluginDataRuntime,
  PluginDataSnapshot,
} from '@maka/runtime/plugin-data-services';

interface DataDocument {
  readonly schemaVersion: 1;
  revision: number;
  values: Record<string, { revision: number; value?: unknown }>;
}
interface CredentialDocument {
  readonly schemaVersion: 1;
  revision: number;
  values: Record<
    string,
    {
      readonly ciphertext: string;
      readonly iv: string;
      readonly tag: string;
      readonly metadata?: Readonly<Record<string, string>>;
    }
  >;
}

const NAMESPACE_QUOTA_BYTES = 10 * 1024 * 1024;

/** Durable per-extension data authority. JSON writes are atomic; secrets are AES-GCM sealed at rest. */
export class HostPluginDataRuntime implements PluginDataRuntime {
  readonly #root: string;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #listeners = new Map<string, Set<(keys: readonly string[]) => void>>();
  #key: Promise<Buffer> | undefined;

  constructor(controlDirectory: string) {
    this.#root = join(controlDirectory, 'plugin-data');
  }

  async read(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    key: string,
  ): Promise<PluginDataSnapshot> {
    return await this.#withNamespace(namespace, async () => {
      const item = (await this.#readData(namespace, domain)).values[key];
      return Object.freeze(
        item
          ? { revision: item.revision, value: clone(item.value) }
          : { revision: 0, value: undefined },
      );
    });
  }

  async list(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    prefix = '',
  ): Promise<Readonly<Record<string, PluginDataSnapshot>>> {
    return await this.#withNamespace(namespace, async () =>
      Object.freeze(
        Object.fromEntries(
          Object.entries((await this.#readData(namespace, domain)).values)
            .filter(([key, item]) => key.startsWith(prefix) && item.value !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [
              key,
              Object.freeze({ revision: item.revision, value: clone(item.value) }),
            ]),
        ),
      ),
    );
  }

  async mutate(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    mutations: readonly PluginDataMutation[],
  ): Promise<Readonly<Record<string, PluginDataSnapshot>>> {
    return await this.#withNamespace(namespace, async () => {
      const document = await this.#readData(namespace, domain);
      const changed = new Set<string>();
      for (const mutation of mutations) {
        const current = document.values[mutation.key];
        const revision = current?.revision ?? 0;
        if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== revision)
          throw new Error(
            `Plugin data revision conflict for ${mutation.key}: expected ${mutation.expectedRevision}, current ${revision}`,
          );
        const nextRevision = revision + 1;
        if (mutation.value === undefined)
          document.values[mutation.key] = { revision: nextRevision };
        else
          document.values[mutation.key] = { revision: nextRevision, value: clone(mutation.value) };
        document.revision += 1;
        changed.add(mutation.key);
      }
      const encoded = `${JSON.stringify(document)}\n`;
      if (Buffer.byteLength(encoded, 'utf8') > NAMESPACE_QUOTA_BYTES)
        throw new Error('Plugin data namespace exceeds 10 MiB quota');
      await atomicWrite(this.#dataPath(namespace, domain), encoded, 0o600);
      const result = Object.freeze(
        Object.fromEntries(
          [...changed].map((key) => {
            const item = document.values[key]!;
            return [key, Object.freeze({ revision: item.revision, value: clone(item.value) })];
          }),
        ),
      );
      queueMicrotask(() => {
        for (const listener of this.#listeners.get(this.#listenerKey(namespace, domain)) ?? [])
          listener(Object.freeze([...changed].sort()));
      });
      return result;
    });
  }

  subscribe(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
    listener: (keys: readonly string[]) => void,
  ): () => void {
    const key = this.#listenerKey(namespace, domain);
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.#listeners.delete(key);
    };
  }

  async hasCredential(namespace: PluginDataNamespace, slot: string): Promise<boolean> {
    return await this.#withNamespace(namespace, async () =>
      Boolean((await this.#readCredentials(namespace)).values[slot]),
    );
  }
  async useCredential<T>(
    namespace: PluginDataNamespace,
    slot: string,
    use: (secret: string) => T | Promise<T>,
  ): Promise<T> {
    const secret = await this.#withNamespace(namespace, async () => {
      const record = (await this.#readCredentials(namespace)).values[slot];
      if (!record) throw new Error(`Plugin credential is unavailable: ${slot}`);
      const key = await this.#encryptionKey();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    });
    return await use(secret);
  }
  async commitCredential(
    namespace: PluginDataNamespace,
    slot: string,
    secret: string,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#withNamespace(namespace, async () => {
      const document = await this.#readCredentials(namespace);
      const key = await this.#encryptionKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      document.values[slot] = {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ...(metadata ? { metadata: Object.freeze({ ...metadata }) } : {}),
      };
      document.revision += 1;
      await atomicWrite(this.#credentialPath(namespace), `${JSON.stringify(document)}\n`, 0o600);
    });
  }
  async removeCredential(namespace: PluginDataNamespace, slot: string): Promise<void> {
    await this.#withNamespace(namespace, async () => {
      const document = await this.#readCredentials(namespace);
      if (!document.values[slot]) return;
      delete document.values[slot];
      document.revision += 1;
      await atomicWrite(this.#credentialPath(namespace), `${JSON.stringify(document)}\n`, 0o600);
    });
  }

  async #readData(
    namespace: PluginDataNamespace,
    domain: 'settings' | 'storage',
  ): Promise<DataDocument> {
    return await readJson(this.#dataPath(namespace, domain), () => ({
      schemaVersion: 1,
      revision: 0,
      values: Object.create(null),
    }));
  }
  async #readCredentials(namespace: PluginDataNamespace): Promise<CredentialDocument> {
    return await readJson(this.#credentialPath(namespace), () => ({
      schemaVersion: 1,
      revision: 0,
      values: Object.create(null),
    }));
  }
  #dataPath(namespace: PluginDataNamespace, domain: string): string {
    return join(this.#root, digest(namespace), `${domain}.json`);
  }
  #credentialPath(namespace: PluginDataNamespace): string {
    return join(this.#root, digest(namespace), 'credentials.json');
  }
  #listenerKey(namespace: PluginDataNamespace, domain: string): string {
    return `${digest(namespace)}:${domain}`;
  }
  async #encryptionKey(): Promise<Buffer> {
    this.#key ??= (async () => {
      const path = join(this.#root, '.credential-key');
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      try {
        const value = await readFile(path);
        if (value.length !== 32) throw new Error('Plugin credential key has invalid length');
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const value = randomBytes(32);
        await writeFile(path, value, { mode: 0o600, flag: 'wx' }).catch(async (writeError) => {
          if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        });
        await chmod(path, 0o600);
        return await readFile(path);
      }
    })();
    return await this.#key;
  }
  async #withNamespace<T>(namespace: PluginDataNamespace, operation: () => Promise<T>): Promise<T> {
    validateNamespace(namespace);
    const key = digest(namespace);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

function validateNamespace(value: PluginDataNamespace): void {
  if (!value.extensionId || !value.scopeId || /[\0\r\n]/u.test(value.extensionId + value.scopeId))
    throw new TypeError('Invalid Plugin data namespace');
}
function digest(value: PluginDataNamespace): string {
  return createHash('sha256').update(`${value.extensionId}\0${value.scopeId}`).digest('hex');
}
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
async function readJson<T>(path: string, fallback: () => T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw new Error(`Unable to read Plugin data: ${path}`, { cause: error });
  }
}
async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const candidate = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(candidate, content, { mode, flag: 'wx' });
  await rename(candidate, path);
  await chmod(path, mode);
}
