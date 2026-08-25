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
  };

  constructor(readonly platform: HostPluginPlatform) {}

  async #query(
    input: PluginPlatformQueryInput,
  ): Promise<OperationOutcome<'plugin.platform.query'>> {
    try {
      return await this.platform.read(async () => {
        const identities = await this.platform.packages.identities();
        const failures = this.platform.failures();
        if (input.view === 'status') {
          const entryCount = countInspections(this.platform.inspect());
          return {
            ok: true,
            result: {
              view: 'status',
              generation: this.platform.desiredComposition().generation,
              packageCount: identities.length,
              entryCount,
              failureCount: failures.length,
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
        const packages = [];
        for (const extensionId of identities) {
          const { manifest } = await this.platform.packages.load(extensionId);
          packages.push({
            extensionId,
            displayName: manifest.displayName,
            ...(manifest.description ? { description: manifest.description } : {}),
            dependencies: manifest.dependencies.map(({ id }) => id),
          });
        }
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
      await this.platform.uninstallPackage(input.extensionId);
      return { ok: true, result: {} };
    } catch (error) {
      return failure(error);
    }
  }

  async #reload(
    input: PluginPackageUninstallInput,
  ): Promise<OperationOutcome<'plugin.package.reload'>> {
    try {
      await this.platform.reloadPackage(input.extensionId);
      return { ok: true, result: {} };
    } catch (error) {
      return failure(error);
    }
  }

  async #export(
    input: PluginPackageExportInput,
  ): Promise<OperationOutcome<'plugin.package.export'>> {
    try {
      await this.platform.read(() =>
        this.platform.packages.export(input.extensionId, input.targetPath),
      );
      return { ok: true, result: { targetPath: input.targetPath } };
    } catch (error) {
      return failure(error);
    }
  }

  async #apply(
    input: MakaCompositionApplyInput,
  ): Promise<OperationOutcome<'plugin.composition.apply'>> {
    try {
      await this.platform.apply(input);
      return {
        ok: true,
        result: { generation: this.platform.desiredComposition().generation },
      };
    } catch (error) {
      return failure(error);
    }
  }
}

function countInspections(inspections: readonly MakaCompositionEntryInspection[]): number {
  return inspections.reduce(
    (total, inspection) => total + 1 + countInspections(inspection.children),
    0,
  );
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
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 32;
  if (cursor > values.length)
    throw new MakaPluginRuntimeError('invalid_entry', 'Invalid query cursor');
  const items: T[] = [];
  for (let index = cursor; index < values.length && items.length < limit; index += 1) {
    const candidate = [...items, values[index] as T];
    if (
      Buffer.byteLength(JSON.stringify({ view, items: candidate, nextCursor: index + 1 }), 'utf8') >
      480 * 1024
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
    nextCursor: next < values.length ? next : null,
  }) as PluginPlatformQueryResult;
}

function failure<K extends keyof PluginPlatformOperationHandlerMap>(
  error: unknown,
): OperationOutcome<K> {
  if (error instanceof HostPluginPlatformError) {
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
