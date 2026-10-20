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

import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type MakaPluginPackage,
  MakaPluginRuntimeError,
  validatePluginPackage,
} from '@maka/runtime/plugin-runtime';
import {
  type InstalledPluginPackage,
  PluginPackageStore,
  PluginPackageStoreError,
} from './plugin-package-store.js';

const GENERATION_DIRECTORY = 'plugin-generations-v1';
const GENERATION_PATH = Symbol('maka.pluginGenerationPath');
const CLIENT_BUNDLE = Symbol('maka.clientPluginBundle');

const clientMarker = Object.freeze({
  name: 'maka-client-composition-marker',
  apply() {},
});

export interface TrustedClientPluginBundle {
  readonly extensionId: string;
  readonly contentDigest: string;
  readonly clientDigest: string;
  readonly totalBytes: number;
}

interface OwnedClientPluginBundle extends TrustedClientPluginBundle {
  readonly path: string;
  readonly generation: string;
}

export class PluginPackageLoaderError extends Error {
  readonly name = 'PluginPackageLoaderError';

  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'load_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Loads trusted packages from immutable generation directories. */
export class TrustedPluginPackageLoader {
  readonly #generations: string;
  readonly #owned = new Set<string>();

  constructor(
    controlDirectory: string,
    readonly store: PluginPackageStore,
  ) {
    this.#generations = join(controlDirectory, GENERATION_DIRECTORY);
  }

  async load(extensionId: string): Promise<MakaPluginPackage> {
    let installed;
    try {
      installed = await this.store.load(extensionId);
    } catch (error) {
      throw translate(error);
    }
    return await this.loadInstalled(installed);
  }

  async loadInstalled(installed: InstalledPluginPackage): Promise<MakaPluginPackage> {
    const generation = join(this.#generations, `${installed.extensionId}-${randomUUID()}`);
    try {
      await mkdir(this.#generations, { recursive: true, mode: 0o700 });
      await cp(installed.root, generation, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: false,
      });
      let pkg: MakaPluginPackage;
      if (installed.entry) {
        const entry = join(generation, relative(installed.root, installed.entry));
        const imported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
        const candidate = imported.default ?? imported.plugin;
        if (!candidate || typeof candidate !== 'object') {
          throw invalid('Plugin Runtime entry must export a MakaPluginPackage as default');
        }
        pkg = candidate as MakaPluginPackage;
      } else {
        pkg = { packageId: installed.extensionId, client: clientMarker };
      }
      if (installed.clientEntry) pkg = { ...pkg, client: clientMarker };
      validatePluginPackage(pkg);
      if (pkg.packageId !== installed.extensionId) {
        throw invalid(
          `Plugin Runtime packageId ${pkg.packageId} does not match manifest ${installed.extensionId}`,
        );
      }
      if (installed.entry && !pkg.host) {
        throw invalid('Trusted Runtime entry must export a host Plugin');
      }
      let clientBundle: OwnedClientPluginBundle | undefined;
      if (installed.clientEntry) {
        const path = join(generation, relative(installed.root, installed.clientEntry));
        const content = await readFile(path);
        clientBundle = Object.freeze({
          extensionId: installed.extensionId,
          contentDigest: installed.contentDigest,
          clientDigest: `sha256-${createHash('sha256').update(content).digest('hex')}`,
          totalBytes: content.byteLength,
          path,
          generation,
        });
      }
      const owned = freezeGeneration(pkg, generation, clientBundle);
      this.#owned.add(generation);
      return owned;
    } catch (error) {
      await rm(generation, { recursive: true, force: true }).catch(() => undefined);
      throw translate(error);
    }
  }

  async collectGarbage(): Promise<void> {
    const entries = await readdir(this.#generations).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of entries) {
      const path = join(this.#generations, name);
      if (!this.#owned.has(path)) await rm(path, { recursive: true, force: true });
    }
  }

  async release(pkg: MakaPluginPackage): Promise<void> {
    const generation = (pkg as MakaPluginPackage & { readonly [GENERATION_PATH]?: string })[
      GENERATION_PATH
    ];
    if (!generation || !this.#owned.delete(generation)) return;
    await rm(generation, { recursive: true, force: true });
  }

  clientBundle(pkg: MakaPluginPackage): TrustedClientPluginBundle | undefined {
    const bundle = clientBundleOf(pkg);
    if (!bundle || !this.#owned.has(bundle.generation)) return undefined;
    return Object.freeze({
      extensionId: bundle.extensionId,
      contentDigest: bundle.contentDigest,
      clientDigest: bundle.clientDigest,
      totalBytes: bundle.totalBytes,
    });
  }

  async readClientBundle(
    pkg: MakaPluginPackage,
    offset: number,
    maxBytes: number,
  ): Promise<{ readonly content: Buffer; readonly totalBytes: number }> {
    const bundle = clientBundleOf(pkg);
    if (!bundle || !this.#owned.has(bundle.generation)) {
      throw new PluginPackageLoaderError(
        'not_found',
        `Plugin package has no active Client generation: ${pkg.packageId}`,
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bundle.totalBytes) {
      throw invalid('Plugin Client bundle offset is invalid');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw invalid('Plugin Client bundle read size is invalid');
    }
    const handle = await open(bundle.path, 'r');
    try {
      const length = Math.min(maxBytes, bundle.totalBytes - offset);
      const content = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(content, 0, length, offset);
      if (bytesRead !== length) throw invalid('Plugin Client bundle ended unexpectedly');
      return Object.freeze({ content, totalBytes: bundle.totalBytes });
    } finally {
      await handle.close();
    }
  }

  async close(): Promise<void> {
    this.#owned.clear();
    await rm(this.#generations, { recursive: true, force: true });
  }
}

function freezeGeneration(
  pkg: MakaPluginPackage,
  generation: string,
  clientBundle?: OwnedClientPluginBundle,
): MakaPluginPackage {
  return Object.freeze({
    ...pkg,
    [GENERATION_PATH]: generation,
    ...(clientBundle ? { [CLIENT_BUNDLE]: clientBundle } : {}),
    ...(pkg.contributions
      ? {
          contributions: Object.freeze(pkg.contributions.map((item) => Object.freeze({ ...item }))),
        }
      : {}),
  });
}

function clientBundleOf(pkg: MakaPluginPackage): OwnedClientPluginBundle | undefined {
  return (pkg as MakaPluginPackage & { readonly [CLIENT_BUNDLE]?: OwnedClientPluginBundle })[
    CLIENT_BUNDLE
  ];
}

function invalid(message: string, cause?: unknown): PluginPackageLoaderError {
  return new PluginPackageLoaderError('invalid_package', message, { cause });
}

function translate(error: unknown): PluginPackageLoaderError {
  if (error instanceof PluginPackageLoaderError) return error;
  if (error instanceof PluginPackageStoreError) {
    return new PluginPackageLoaderError(
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'invalid_package'
          ? 'invalid_package'
          : 'load_failed',
      error.message,
      { cause: error },
    );
  }
  if (error instanceof MakaPluginRuntimeError) return invalid(error.message, error);
  return new PluginPackageLoaderError('load_failed', 'Unable to load Plugin package', {
    cause: error,
  });
}
