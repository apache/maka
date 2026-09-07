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

import { createHash } from 'node:crypto';
import {
  MakaPluginRuntimeError,
  type MakaCompositionApplyInput,
  type MakaCompositionEntryInspection,
} from '@maka/runtime/plugin-runtime';
import type {
  OperationOutcome,
  PluginPackageExportInput,
  PluginPackageInstallInput,
  PluginPackageProjection,
  PluginPackageUninstallInput,
  PluginPlatformFailureProjection,
  PluginPlatformQueryInput,
  PluginPlatformQueryResult,
} from '../protocol/index.js';
import { PLUGIN_PLATFORM_QUERY_RESULT_MAX_BYTES } from '../protocol/plugin-platform.js';
import { ExtensionBundleError } from './extension-bundle.js';
import { ExtensionPackageManifestError } from './extension-package-manifest.js';
import type { PluginPlatformOperationHandlerMap } from './operation-dispatcher.js';
import { PluginCompositionPatchError } from './plugin-composition-patch.js';
import { PluginPackageLoaderError } from './plugin-package-loader.js';
import { PluginPackageStoreError } from './plugin-package-store.js';
import { HostPluginPlatform, HostPluginPlatformError } from './plugin-platform.js';

export class HostPluginPlatformCoordinator {
  readonly handlers: PluginPlatformOperationHandlerMap = {
    'plugin.platform.query': (input) => this.#query(input),
    'plugin.package.install': (input) => this.#install(input),
    'plugin.package.uninstall': (input) => this.#uninstall(input),
    'plugin.package.reload': (input) => this.#reload(input),
    'plugin.package.export': (input) => this.#export(input),
    'plugin.composition.apply': (input) => this.#apply(input),
    'plugin.platform.reconcile': () => this.#reconcile(),
  };

  constructor(readonly platform: HostPluginPlatform) {}

  async #query(
    input: PluginPlatformQueryInput,
  ): Promise<OperationOutcome<'plugin.platform.query'>> {
    try {
      return await this.platform.read(async () => {
        const failures = this.platform.failures();
        if (input.view === 'status') {
          return {
            ok: true,
            result: {
              view: 'status',
              ...(await this.platform.status()),
            },
          };
        }
        if (input.view === 'entries') {
          const inspections = flattenInspections(this.platform.inspect(input.rootId));
          return { ok: true, result: boundedPage('entries', inspections, input) };
        }
        if (input.view === 'failures') {
          return { ok: true, result: boundedPage('failures', failures, input) };
        }
        const packages = await this.platform.packageProjections();
        return {
          ok: true,
          result: boundedPage('packages', packages, input),
        };
      });
    } catch (error) {
      return failure(error);
    }
  }

  async #install(
    input: PluginPackageInstallInput,
  ): Promise<OperationOutcome<'plugin.package.install'>> {
    try {
      return { ok: true, result: await this.platform.installPackage(input.sourcePath) };
    } catch (error) {
      return failure(error);
    }
  }

  async #uninstall(
    input: PluginPackageUninstallInput,
  ): Promise<OperationOutcome<'plugin.package.uninstall'>> {
    try {
      return { ok: true, result: await this.platform.uninstallPackage(input.extensionId) };
    } catch (error) {
      return failure(error);
    }
  }

  async #reload(
    input: PluginPackageUninstallInput,
  ): Promise<OperationOutcome<'plugin.package.reload'>> {
    try {
      return { ok: true, result: await this.platform.reloadPackage(input.extensionId) };
    } catch (error) {
      return failure(error);
    }
  }

  async #export(
    input: PluginPackageExportInput,
  ): Promise<OperationOutcome<'plugin.package.export'>> {
    try {
      await this.platform.exportPackage(input.extensionId, input.targetPath);
      return { ok: true, result: { targetPath: input.targetPath } };
    } catch (error) {
      return failure(error);
    }
  }

  async #apply(
    input: MakaCompositionApplyInput,
  ): Promise<OperationOutcome<'plugin.composition.apply'>> {
    try {
      return { ok: true, result: await this.platform.apply(input) };
    } catch (error) {
      return failure(error);
    }
  }

  async #reconcile(): Promise<OperationOutcome<'plugin.platform.reconcile'>> {
    try {
      return { ok: true, result: await this.platform.reconcile() };
    } catch (error) {
      return failure(error);
    }
  }
}

function flattenInspections(
  inspections: readonly MakaCompositionEntryInspection[],
): readonly MakaCompositionEntryInspection[] {
  const flattened: MakaCompositionEntryInspection[] = [];
  const visit = (items: readonly MakaCompositionEntryInspection[]): void => {
    for (const item of items) {
      flattened.push(Object.freeze({ ...item, children: Object.freeze([]) }));
      visit(item.children);
    }
  };
  visit(inspections);
  return Object.freeze(flattened);
}

function boundedPage(
  view: 'packages',
  values: readonly PluginPackageProjection[],
  input: PluginPlatformQueryInput,
): Extract<PluginPlatformQueryResult, { readonly view: 'packages' }>;
function boundedPage(
  view: 'entries',
  values: readonly MakaCompositionEntryInspection[],
  input: PluginPlatformQueryInput,
): Extract<PluginPlatformQueryResult, { readonly view: 'entries' }>;
function boundedPage(
  view: 'failures',
  values: readonly PluginPlatformFailureProjection[],
  input: PluginPlatformQueryInput,
): Extract<PluginPlatformQueryResult, { readonly view: 'failures' }>;
function boundedPage<T>(
  view: 'packages' | 'entries' | 'failures',
  values: readonly T[],
  input: PluginPlatformQueryInput,
): PluginPlatformQueryResult {
  const digest = pageDigest(view, input.rootId, values);
  const cursor =
    input.cursor === undefined ? 0 : decodeCursor(input.cursor, view, input.rootId, digest);
  const limit = input.limit ?? 32;
  if (cursor > values.length)
    throw new HostPluginPlatformError('stale_cursor', 'Plugin Platform query cursor is stale');
  const items: T[] = [];
  for (let index = cursor; index < values.length && items.length < limit; index += 1) {
    const candidate = [...items, values[index] as T];
    if (
      Buffer.byteLength(
        JSON.stringify({
          view,
          items: candidate,
          nextCursor: encodeCursor(view, input.rootId, digest, index + 1),
        }),
        'utf8',
      ) > PLUGIN_PLATFORM_QUERY_RESULT_MAX_BYTES
    ) {
      break;
    }
    items.push(values[index] as T);
  }
  if (cursor < values.length && items.length === 0) {
    throw new MakaPluginRuntimeError('invalid_entry', 'Plugin Platform page item is too large');
  }
  const next = cursor + items.length;
  return Object.freeze({
    view,
    items: Object.freeze(items),
    nextCursor: next < values.length ? encodeCursor(view, input.rootId, digest, next) : null,
  }) as PluginPlatformQueryResult;
}

interface PageCursor {
  readonly version: 1;
  readonly view: 'packages' | 'entries' | 'failures';
  readonly rootId?: string;
  readonly digest: string;
  readonly offset: number;
}

function pageDigest(view: string, rootId: string | undefined, values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ view, rootId: rootId ?? null, values }))
    .digest('base64url');
}

function encodeCursor(
  view: PageCursor['view'],
  rootId: string | undefined,
  digest: string,
  offset: number,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, view, ...(rootId ? { rootId } : {}), digest, offset }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(
  encoded: string,
  view: PageCursor['view'],
  rootId: string | undefined,
  digest: string,
): number {
  try {
    const cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PageCursor;
    if (
      cursor.version !== 1 ||
      cursor.view !== view ||
      cursor.rootId !== rootId ||
      cursor.digest !== digest ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    ) {
      throw new Error('mismatch');
    }
    return cursor.offset;
  } catch {
    throw new HostPluginPlatformError('stale_cursor', 'Plugin Platform query cursor is stale');
  }
}

function failure<K extends keyof PluginPlatformOperationHandlerMap>(
  error: unknown,
): OperationOutcome<K> {
  if (error instanceof HostPluginPlatformError) {
    if (error.code === 'not_ready') return failed('host_not_ready', error.message);
    if (error.code === 'stale_cursor') return failed('stale_cursor', error.message);
    if (error.code === 'closed') return failed('host_draining', error.message);
    if (error.code === 'persistence_failed') return failed('persistence_failed', error.message);
    if (error.code === 'recovery_failed') return failed('persistence_failed', error.message);
    if (error.code === 'commit_outcome_unknown') {
      return failed('commit_outcome_unknown', error.message);
    }
    if (error.code === 'mutation_failed' && error.cause) return failure(error.cause);
    return failed('internal_failure', error.message);
  }
  if (error instanceof PluginPackageStoreError) {
    if (error.code === 'not_found') return failed('not_found', error.message);
    if (error.code === 'invalid_package') return failed('invalid_request', error.message);
    if (error.code === 'commit_outcome_unknown') {
      return failed('commit_outcome_unknown', error.message);
    }
    return failed('persistence_failed', error.message);
  }
  if (error instanceof PluginPackageLoaderError) {
    if (error.code === 'not_found') return failed('not_found', error.message);
    if (error.code === 'invalid_package') return failed('invalid_request', error.message);
    return failed('persistence_failed', error.message);
  }
  if (
    error instanceof ExtensionBundleError ||
    error instanceof ExtensionPackageManifestError ||
    error instanceof PluginCompositionPatchError
  ) {
    return failed('invalid_request', error.message);
  }
  if (error instanceof MakaPluginRuntimeError) {
    switch (error.code) {
      case 'package_not_found':
      case 'entry_not_found':
        return failed('not_found', error.message);
      case 'package_exists':
      case 'package_in_use':
      case 'entry_exists':
        return failed('operation_conflict', error.message);
      case 'invalid_package':
      case 'invalid_entry':
      case 'dependency_cycle':
        return failed('invalid_request', error.message);
      default:
        return failed('internal_failure', error.message);
    }
  }
  return failed('internal_failure', 'Plugin Platform operation failed');
}

function failed<K extends keyof PluginPlatformOperationHandlerMap>(
  code: string,
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}
