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

import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { ComputerHistoryApplication } from '@maka/core/computer-history';
import { historyApplicationId, isWindowsExecutableId, isWindowsPackagedId } from '@maka/core/computer-history';

const MAX_BATCH = 32;
const MAX_CACHE = 256;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ICON_BYTES = 48 * 1024;
const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
const TIMEOUT_MS = 5_000;
const PNG_PREFIX = 'data:image/png;base64,';

type Pending = {
  promise: Promise<ComputerHistoryApplication>;
  resolve(value: ComputerHistoryApplication): void;
  reject(error: unknown): void;
};

// Helper-only status. A complete Windows enumeration must distinguish absence from uncertainty.
type ApplicationLookup = ComputerHistoryApplication & {
  resolution?: 'resolved' | 'registered' | 'not_running' | 'unavailable';
};

/** Local, permission-free, memory-only lookup. One helper batch at a time, coalesced per ID. */
export class ComputerHistoryApplications {
  readonly #helperPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: typeof spawn;
  readonly #now: () => number;
  readonly #cache = new Map<string, {
    value: ComputerHistoryApplication;
    expires: number;
    retainWhenClosed: boolean;
  }>();
  readonly #pending = new Map<string, Pending>();
  readonly #queued = new Set<string>();
  #scheduled = false;
  #draining = false;
  #closed = false;
  #cancel?: () => void;

  constructor(input: {
    helperPath: string;
    platform?: NodeJS.Platform;
    spawn?: typeof spawn;
    now?: () => number;
  }) {
    this.#helperPath = input.helperPath;
    this.#platform = input.platform ?? process.platform;
    this.#spawn = input.spawn ?? spawn;
    this.#now = input.now ?? Date.now;
  }

  async applications(bundleIds: readonly string[]): Promise<readonly ComputerHistoryApplication[]> {
    const ids = requestedIds(bundleIds);
    if (this.#closed) throw new Error('Computer History application lookup is closed');
    const needed = ids.filter((id) => !this.#cached(id) && !this.#pending.has(id));
    if (this.#pending.size + needed.length > MAX_CACHE) {
      throw new Error('Computer History application lookup is busy');
    }
    const results = ids.map((id) => {
      const cached = this.#cached(id);
      if (cached) return Promise.resolve(cached);
      let pending = this.#pending.get(id);
      if (!pending) {
        let resolve!: Pending['resolve'];
        let reject!: Pending['reject'];
        const promise = new Promise<ComputerHistoryApplication>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        pending = { promise, resolve, reject };
        this.#pending.set(id, pending);
        this.#queued.add(id);
      }
      return pending.promise;
    });
    if (this.#queued.size && !this.#scheduled && !this.#draining) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        void this.#drain();
      });
    }
    // Copies keep callers from mutating the cache or another joined request's result.
    return (await Promise.all(results)).map((value) => ({ ...value }));
  }

  dispose(): void {
    this.#closed = true;
    this.#cancel?.();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Computer History application lookup is closed'));
    }
    this.#pending.clear();
    this.#queued.clear();
    this.#cache.clear();
  }

  #cached(id: string): ComputerHistoryApplication | undefined {
    const cached = this.#cache.get(id);
    // An expired icon is retained only as a candidate for explicit native not_running.
    // It is never returned before revalidation and remains inside the same bounded LRU.
    if (!cached || cached.expires <= this.#now()) return undefined;
    this.#cache.delete(id);
    this.#cache.set(id, cached);
    return cached.value;
  }

  async #drain(): Promise<void> {
    if (this.#closed || this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queued.size && !this.#closed) {
        const ids = [...this.#queued].slice(0, MAX_BATCH);
        for (const id of ids) this.#queued.delete(id);
        try {
          const values = await this.#lookup(ids);
          if (this.#closed) return;
          for (const { resolution, ...result } of values) {
            const previous = this.#cache.get(result.bundleIdentifier);
            const retain = this.#platform === 'win32' && resolution === 'not_running' &&
              previous?.retainWhenClosed === true && Boolean(previous.value.iconDataUrl);
            const value = retain ? previous!.value : result;
            this.#cache.delete(value.bundleIdentifier);
            this.#cache.set(value.bundleIdentifier, {
              value,
              expires: this.#now() + (value.iconDataUrl && !retain ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
              retainWhenClosed: retain || resolution === 'resolved',
            });
            if (this.#cache.size > MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value!);
            this.#pending.get(value.bundleIdentifier)!.resolve(value);
            this.#pending.delete(value.bundleIdentifier);
          }
        } catch (error) {
          for (const id of ids) {
            this.#cache.delete(id);
            this.#pending.get(id)?.reject(error);
            this.#pending.delete(id);
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #lookup(ids: readonly string[]): Promise<readonly ApplicationLookup[]> {
    const fallback = () => ids.map((bundleIdentifier) => ({
      bundleIdentifier, name: bundleIdentifier, iconDataUrl: null,
    }));
    if (this.#platform !== 'darwin' && this.#platform !== 'win32') return fallback();
    try {
      await access(this.#helperPath, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return fallback();
      }
      throw new Error('Computer History application helper is unavailable');
    }
    if (this.#closed) throw new Error('Computer History application lookup is closed');
    const supported = this.#platform === 'win32'
      ? ids.filter(isWindowsApplicationId)
      : ids.filter((id) => !isWindowsApplicationId(id));
    if (!supported.length) return fallback();
    const values = new Map((await this.#runHelper(supported)).map((value) => [value.bundleIdentifier, value]));
    return fallback().map((value) => values.get(value.bundleIdentifier) ?? value);
  }

  #runHelper(ids: readonly string[]): Promise<readonly ApplicationLookup[]> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.#spawn(this.#helperPath, ['applications', ...ids], {
          shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        reject(new Error('Computer History application helper failed'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, values?: readonly ApplicationLookup[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#cancel = undefined;
        child.stdout?.removeListener('data', onData);
        if (error) {
          child.kill('SIGKILL');
          reject(error);
        } else {
          resolve(values!);
        }
      };
      const onData = (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish(new Error('Computer History application response exceeds the limit'));
          return;
        }
        chunks.push(data);
      };
      const timer = setTimeout(() => {
        finish(new Error('Computer History application helper timed out'));
      }, TIMEOUT_MS);
      this.#cancel = () => finish(new Error('Computer History application lookup is closed'));
      child.stdout?.on('data', onData);
      child.once('error', () => finish(new Error('Computer History application helper failed')));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error('Computer History application helper failed'));
          return;
        }
        try {
          finish(undefined, decodeApplications(Buffer.concat(chunks, bytes), ids, this.#platform === 'win32'));
        } catch {
          finish(new Error('Invalid Computer History application response'));
        }
      });
    });
  }
}

function isWindowsApplicationId(id: string): boolean {
  return isWindowsExecutableId(id) || isWindowsPackagedId(id);
}

function requestedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH || Array.from(value).some((id) =>
    historyApplicationId({ bundleIdentifier: id }) === null,
  )) {
    throw new Error('Invalid Computer History application identifiers');
  }
  return [...new Set(value)] as string[];
}

function decodeApplications(bytes: Buffer, ids: readonly string[], windows: boolean): ApplicationLookup[] {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.length !== ids.length) throw new Error('Invalid applications');
  const remaining = new Set(ids);
  const values = new Map<string, ApplicationLookup>();
  for (const item of value) {
    const hasResolution = item && Object.hasOwn(item, 'resolution');
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).sort().join(',') !==
        `bundleIdentifier,iconDataUrl,name${hasResolution ? ',resolution' : ''}` ||
      (hasResolution && (!windows || !['resolved', 'registered', 'not_running', 'unavailable'].includes(item.resolution) ||
        (!['resolved', 'registered'].includes(item.resolution) && (item.iconDataUrl !== null || item.name !== item.bundleIdentifier)))) ||
      !remaining.delete(item.bundleIdentifier) ||
      typeof item.name !== 'string' || !item.name.trim() || Buffer.byteLength(item.name) > 512 ||
      /[\u0000-\u001f\u007f]/u.test(item.name) ||
      (item.iconDataUrl !== null && !validPngDataUrl(item.iconDataUrl))
    ) throw new Error('Invalid application');
    values.set(item.bundleIdentifier, {
      bundleIdentifier: item.bundleIdentifier, name: item.name, iconDataUrl: item.iconDataUrl,
      ...(hasResolution ? { resolution: item.resolution } : {}),
    });
  }
  return ids.map((id) => values.get(id)!);
}

function validPngDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX) ||
    value.length > PNG_PREFIX.length + Math.ceil(MAX_ICON_BYTES / 3) * 4
  ) return false;
  const encoded = value.slice(PNG_PREFIX.length);
  const png = Buffer.from(encoded, 'base64');
  // Our bundled helper rasterizes a fresh bitmap. Bound its envelope here; the browser owns decoding.
  return png.length >= 33 && png.length <= MAX_ICON_BYTES && png.toString('base64') === encoded &&
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    png.readUInt32BE(8) === 13 && png.toString('ascii', 12, 16) === 'IHDR' &&
    png.readUInt32BE(16) === 48 && png.readUInt32BE(20) === 48 &&
    png[24] === 8 && png[25] === 6 && png[26] === 0 && png[27] === 0 && png[28] === 0;
}
