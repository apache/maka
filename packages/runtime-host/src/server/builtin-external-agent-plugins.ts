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

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { RuntimePolicySnapshot } from '@maka/core/runtime-policy';
import type { MakaCompositionOperation } from '@maka/runtime/plugin-runtime';
import { extensionPackageDirectoryContentDigest } from './extension-bundle.js';
import type { ExtensionPackageManifest } from './extension-package-manifest.js';
import type { HostPluginPlatform } from './plugin-platform.js';

const ACP_RUNTIME_PACKAGE_ID = 'acp-executor';
const ACP_RUNTIME_ENTRY_ID = 'acp-runtime';
const ANTIGRAVITY_PACKAGE_ID = 'antigravity-acp';
const ANTIGRAVITY_ENTRY_ID = 'antigravity-acp';
const STAGING_DIRECTORY = 'builtin-plugin-staging-v1';
const RUNTIME_ENTRY = 'plugin.mjs';
const COMPOSITION_PATCH = 'maka.composition.json';

// Built-in setup entries remain discoverable before their Plugin is installed.
// Registered Plugins replace these placeholders with their live catalogs.
const BUILTIN_EXTERNAL_AGENT_CATALOG: readonly ExecutorCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: ANTIGRAVITY_ENTRY_ID,
    displayName: 'Antigravity',
    readiness: 'unavailable' as const,
    models: Object.freeze([]),
    supportsAttachments: false,
    supportsModelChange: false,
  }),
]);

export function withBuiltinExternalAgentCatalog(
  catalog: readonly ExecutorCatalogEntry[],
): readonly ExecutorCatalogEntry[] {
  const registered = new Set(catalog.map((entry) => entry.id));
  return [
    ...catalog,
    ...BUILTIN_EXTERNAL_AGENT_CATALOG.filter((entry) => !registered.has(entry.id)),
  ];
}

export interface BuiltinExternalAgentPluginEntries {
  readonly acpRuntime: string;
  readonly antigravity: string;
}

interface StagedPackage {
  readonly root: string;
  readonly digest: string;
  dispose(): Promise<void>;
}

/**
 * Projects durable product settings into reserved Plugin packages and Entries.
 *
 * RuntimePolicy remains the owner of setup facts. The generated package layer
 * is replaceable derived state, so adapter code never reads RuntimePolicy and
 * repeated reconciliation does not append unbounded user composition overlays.
 */
export class HostBuiltinExternalAgentPluginCoordinator {
  readonly #platform: Pick<
    HostPluginPlatform,
    'installPackage' | 'uninstallPackage' | 'packageProjections'
  >;
  readonly #controlDirectory: string;
  readonly #readPolicy: () => Promise<RuntimePolicySnapshot>;
  readonly #entries: BuiltinExternalAgentPluginEntries;
  #gate: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly platform: Pick<
      HostPluginPlatform,
      'installPackage' | 'uninstallPackage' | 'packageProjections'
    >;
    readonly controlDirectory: string;
    readonly readPolicy: () => Promise<RuntimePolicySnapshot>;
    readonly entries?: BuiltinExternalAgentPluginEntries;
  }) {
    this.#platform = input.platform;
    this.#controlDirectory = input.controlDirectory;
    this.#readPolicy = input.readPolicy;
    this.#entries = input.entries ?? resolveBuiltinExternalAgentPluginEntries();
  }

  async recover(): Promise<void> {
    await rm(join(this.#controlDirectory, STAGING_DIRECTORY), { recursive: true, force: true });
    return await this.reconcile();
  }

  reconcile(): Promise<void> {
    const task = this.#gate.then(() => this.#reconcileNow());
    this.#gate = task.catch(() => undefined);
    return task;
  }

  async #reconcileNow(): Promise<void> {
    const executable = (await this.#readPolicy()).policy.externalAgents.antigravity.executable;
    if (!executable) {
      await this.#removeIfInstalled(ANTIGRAVITY_PACKAGE_ID);
      await this.#removeIfInstalled(ACP_RUNTIME_PACKAGE_ID);
      return;
    }

    await this.#ensurePackage(
      ACP_RUNTIME_PACKAGE_ID,
      this.#entries.acpRuntime,
      acpRuntimeManifest(),
      [
        {
          type: 'insert',
          rootId: 'profile',
          entry: {
            id: ACP_RUNTIME_ENTRY_ID,
            packageId: ACP_RUNTIME_PACKAGE_ID,
            isolate: { acp: true },
          },
        },
      ],
    );
    await this.#ensurePackage(
      ANTIGRAVITY_PACKAGE_ID,
      this.#entries.antigravity,
      antigravityManifest(),
      [
        {
          type: 'insert',
          parentId: ACP_RUNTIME_ENTRY_ID,
          entry: {
            id: ANTIGRAVITY_ENTRY_ID,
            packageId: ANTIGRAVITY_PACKAGE_ID,
            config: { executable },
          },
        },
      ],
    );
  }

  async #ensurePackage(
    extensionId: string,
    runtimeEntry: string,
    manifest: ExtensionPackageManifest,
    operations: readonly MakaCompositionOperation[],
  ): Promise<void> {
    const staged = await stagePackage(this.#controlDirectory, runtimeEntry, manifest, operations);
    try {
      const installed = (await this.#platform.packageProjections()).find(
        (candidate) => candidate.extensionId === extensionId,
      );
      if (installed?.contentDigest === staged.digest) return;
      await this.#platform.installPackage(staged.root);
    } finally {
      await staged.dispose();
    }
  }

  async #removeIfInstalled(extensionId: string): Promise<void> {
    const installed = (await this.#platform.packageProjections()).some(
      (candidate) => candidate.extensionId === extensionId,
    );
    if (installed) await this.#platform.uninstallPackage(extensionId);
  }
}

export function resolveBuiltinExternalAgentPluginEntries(): BuiltinExternalAgentPluginEntries {
  return Object.freeze({
    acpRuntime: fileURLToPath(import.meta.resolve('@maka/acp-executor-plugin/plugin')),
    antigravity: fileURLToPath(import.meta.resolve('@maka/antigravity-acp-plugin/plugin')),
  });
}

async function stagePackage(
  controlDirectory: string,
  runtimeEntry: string,
  manifest: ExtensionPackageManifest,
  operations: readonly MakaCompositionOperation[],
): Promise<StagedPackage> {
  const stagingRoot = join(controlDirectory, STAGING_DIRECTORY);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(stagingRoot, '.package-'));
  try {
    await copyFile(runtimeEntry, join(root, RUNTIME_ENTRY));
    await writeFile(join(root, 'maka.extension.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(join(root, COMPOSITION_PATCH), `${JSON.stringify(operations, null, 2)}\n`, {
      mode: 0o600,
    });
    return Object.freeze({
      root,
      digest: await extensionPackageDirectoryContentDigest(root),
      dispose: () => rm(root, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function acpRuntimeManifest(): ExtensionPackageManifest {
  return Object.freeze({
    schemaVersion: 1,
    id: ACP_RUNTIME_PACKAGE_ID,
    displayName: 'ACP Executor Runtime',
    description: 'Shared ACP protocol and process runtime for external Agent adapter plugins.',
    dependencies: Object.freeze([]),
    configuration: Object.freeze({ properties: Object.freeze({}), required: Object.freeze([]) }),
    runtime: Object.freeze({ entry: RUNTIME_ENTRY }),
    composition: Object.freeze({
      patch: COMPOSITION_PATCH,
      structuralDependencies: Object.freeze([]),
    }),
  });
}

function antigravityManifest(): ExtensionPackageManifest {
  return Object.freeze({
    schemaVersion: 1,
    id: ANTIGRAVITY_PACKAGE_ID,
    displayName: 'Antigravity ACP',
    description: 'Runs Google Antigravity as an external Agent through ACP.',
    dependencies: Object.freeze([{ id: ACP_RUNTIME_PACKAGE_ID }]),
    configuration: Object.freeze({
      properties: Object.freeze({
        executable: Object.freeze({ type: 'string', title: 'ACP executable' }),
      }),
      required: Object.freeze(['executable']),
    }),
    runtime: Object.freeze({ entry: RUNTIME_ENTRY }),
    composition: Object.freeze({
      patch: COMPOSITION_PATCH,
      structuralDependencies: Object.freeze([ACP_RUNTIME_PACKAGE_ID]),
    }),
  });
}
