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

import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
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
      const entry = join(generation, relative(installed.root, installed.entry));
      const imported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
      const candidate = imported.default ?? imported.plugin;
      if (!candidate || typeof candidate !== 'object') {
        throw invalid('Plugin Runtime entry must export a MakaPluginPackage as default');
      }
      const pkg = candidate as MakaPluginPackage;
      validatePluginPackage(pkg);
      if (pkg.packageId !== installed.extensionId) {
        throw invalid(
          `Plugin Runtime packageId ${pkg.packageId} does not match manifest ${installed.extensionId}`,
        );
      }
      if (!pkg.host) throw invalid('Trusted Host package must export a host Plugin');
      const owned = freezeGeneration(pkg, generation);
      this.#owned.add(generation);
      return owned;
    } catch (error) {
      await rm(generation, { recursive: true, force: true }).catch(() => undefined);
      throw translate(error);
    }
  }

  async collectGarbage(): Promise<void> {
    this.#owned.clear();
    await rm(this.#generations, { recursive: true, force: true });
  }

  async release(pkg: MakaPluginPackage): Promise<void> {
    const generation = (pkg as MakaPluginPackage & { readonly [GENERATION_PATH]?: string })[
      GENERATION_PATH
    ];
    if (!generation || !this.#owned.delete(generation)) return;
    await rm(generation, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.#owned.clear();
    await rm(this.#generations, { recursive: true, force: true });
  }
}

function freezeGeneration(pkg: MakaPluginPackage, generation: string): MakaPluginPackage {
  return Object.freeze({
    ...pkg,
    [GENERATION_PATH]: generation,
    ...(pkg.contributions
      ? {
          contributions: Object.freeze(pkg.contributions.map((item) => Object.freeze({ ...item }))),
        }
      : {}),
  });
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
