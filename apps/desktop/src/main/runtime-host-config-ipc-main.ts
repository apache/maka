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

import { readFile, writeFile } from 'node:fs/promises';
import type { IpcMain } from 'electron';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import type { LlmConnection } from '@maka/core/llm-connections';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import type {
  ConnectionCatalogEntry,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import {
  applyConfigImport,
  type ConfigTransferDeps,
  type ExportedCredential,
} from './config-transfer-service.js';
import type { createMainWindowController } from './main-window.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  projectHostConnections,
} from './runtime-host-connections-ipc-main.js';
import {
  readRuntimeHostMemoryDocument,
  replaceRuntimeHostMemoryDocument,
} from './runtime-host-memory-ipc-main.js';
import {
  stripSettingsSecretsForExport,
} from './settings-ipc-helpers.js';
import {
  buildConfigBundle,
  isConfigCategory,
  parseConfigBundle,
  serializeConfigBundle,
  type ConfigCategory,
  type ConfigData,
  type ConnectionConflictStrategy,
} from '@maka/storage';

interface RuntimeHostConfigIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: DesktopRuntimeHostClient;
  readonly mainWindowController: ReturnType<typeof createMainWindowController>;
  readonly appVersion: string;
  readonly getSettings: () => Promise<AppSettings>;
  readonly updateSettings: (
    patch: UpdateAppSettingsInput,
  ) => Promise<AppSettings>;
  readonly emitConnectionsChanged: () => void;
}

export function registerRuntimeHostConfigIpc(
  deps: RuntimeHostConfigIpcDeps,
): void {
  deps.ipcMain.handle(
    'config:export',
    async (_event, input: { categories?: unknown } = {}) => {
      const categories = sanitizeCategories(input?.categories);
      if (categories.length === 0) {
        return { ok: false as const, reason: 'no_categories' as const };
      }
      const bundle = await gatherRuntimeHostConfig(categories, deps);
      const today = new Date().toISOString().slice(0, 10);
      const result = await deps.mainWindowController.showSaveDialog({
        title: '导出 Maka 配置',
        defaultPath: `maka-config-${today}.json`,
        filters: [{ name: 'Maka Config', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false as const, reason: 'canceled' as const };
      }
      await writeFile(result.filePath, serializeConfigBundle(bundle), 'utf8');
      return {
        ok: true as const,
        path: result.filePath,
        includedData: bundle.includedData,
      };
    },
  );

  deps.ipcMain.handle(
    'config:import',
    async (_event, input: { strategy?: unknown } = {}) => {
      const result = await deps.mainWindowController.showOpenDialog({
        title: '导入 Maka 配置',
        properties: ['openFile'],
        filters: [{ name: 'Maka Config', extensions: ['json'] }],
      });
      const filePath = result.filePaths?.[0];
      if (result.canceled || !filePath) {
        return { ok: false as const, reason: 'canceled' as const };
      }
      const parsed = parseConfigBundle(await readFile(filePath, 'utf8'));
      if (!parsed.ok) {
        return {
          ok: false as const,
          reason: parsed.reason,
          message: parsed.message,
        };
      }
      const imported = await applyConfigImport(
        parsed.bundle,
        sanitizeStrategy(input?.strategy),
        runtimeHostTransferDeps(deps),
      );
      deps.emitConnectionsChanged();
      return {
        ok: true as const,
        includedData: parsed.bundle.includedData,
        result: imported,
      };
    },
  );
}

export async function gatherRuntimeHostConfig(
  categories: readonly ConfigCategory[],
  deps: RuntimeHostConfigIpcDeps,
) {
  const selected = new Set(categories);
  const data: ConfigData = {};
  const catalog =
    selected.has('connections') || selected.has('credentials')
      ? await deps.client.loadConnectionCatalog()
      : undefined;
  const locators = selected.has('credentials')
    ? exportLocators(catalog?.connections ?? [])
    : [];
  const exported = await exportConfigurationCredentials(deps.client, locators);
  const secrets = new Map(
    exported.credentials.map((entry) => [locatorKey(entry.locator), entry.secret]),
  );

  if (selected.has('connections') && catalog) {
    data.connections = projectHostConnections(catalog);
  }
  if (selected.has('settings')) {
    const settings = await deps.getSettings();
    data.settings = selected.has('credentials')
      ? restoreHostSettingsSecrets(settings, secrets)
      : stripSettingsSecretsForExport(settings);
  }
  if (selected.has('credentials') && catalog) {
    data.credentials = connectionCredentials(catalog.connections, secrets);
  }
  if (selected.has('memory')) {
    data.memory = await readRuntimeHostMemoryDocument(deps.client, 'memory');
  }
  return buildConfigBundle({ appVersion: deps.appVersion, data });
}

async function exportConfigurationCredentials(
  client: DesktopRuntimeHostClient,
  locators: readonly CredentialLocator[],
) {
  const credentials: Array<{ locator: CredentialLocator; secret: string }> = [];
  for (const locator of locators) {
    const exported = await client.exportConfigurationCredentials({ locator });
    if (exported.credential) {
      credentials.push({
        locator: exported.credential.locator,
        secret: Buffer.from(exported.credential.secretBase64, 'base64').toString('utf8'),
      });
    }
  }
  return { credentials };
}

function runtimeHostTransferDeps(
  deps: RuntimeHostConfigIpcDeps,
): ConfigTransferDeps {
  return {
    connectionStore: {
      list: async () =>
        projectHostConnections(await deps.client.loadConnectionCatalog()),
      save: (connection) => saveConnection(deps.client, connection),
    },
    settingsStore: {
      update: deps.updateSettings,
    },
    credentialStore: {
      setSecret: (slug, kind, value) =>
        saveConnectionCredential(deps.client, slug, kind, value),
    },
    writeMemory: (content) =>
      replaceRuntimeHostMemoryDocument(deps.client, content),
  };
}

// Exported for the import-overwrite tests: this adapter is where snapshot
// semantics meet the Host's tri-state update contract.
export async function saveConnection(
  client: DesktopRuntimeHostClient,
  connection: LlmConnection,
): Promise<LlmConnection> {
  let catalog = await client.loadConnectionCatalog();
  let existing = catalog.connections.find((item) => item.slug === connection.slug);
  if (existing && existing.providerType !== connection.providerType) {
    const removed = await client.removeConnection({
      connectionId: existing.connectionId,
      revision: existing.revision,
    });
    if (removed.kind !== 'committed') {
      throw new Error(`Unable to replace imported Connection: ${removed.kind}`);
    }
    catalog = await client.loadConnectionCatalog();
    existing = undefined;
  }
  if (existing) {
    const updated = await client.updateConnection(
      { connectionId: existing.connectionId, revision: existing.revision },
      {
        name: connection.name,
        ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
        enabled: connection.enabled,
        enabledModelIds: [...(connection.enabledModelIds ?? [])],
        // Import-overwrite is snapshot replacement: absent in the snapshot
        // must CLEAR, not inherit — the update contract's "absent means
        // untouched" would otherwise resurrect the old profiles.
        relayModelProfiles: connection.relayModelProfiles ?? null,
        requestBodyOverlay: connection.requestBodyOverlay ?? null,
      },
    );
    if (updated.kind !== 'committed') {
      throw new Error(`Unable to update imported Connection: ${updated.kind}`);
    }
  } else {
    const importedProfiles = connection.relayModelProfiles;
    const created = await client.createConnection(catalog.revision, {
      slug: connection.slug,
      name: connection.name,
      providerType: connection.providerType,
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      enabled: connection.enabled,
      enabledModelIds: [...(connection.enabledModelIds ?? [])],
      ...(importedProfiles === undefined ? {} : { relayModelProfiles: importedProfiles }),
      ...(connection.requestBodyOverlay === undefined
        ? {}
        : { requestBodyOverlay: connection.requestBodyOverlay }),
    });
    if (created.kind !== 'committed') {
      throw new Error(`Unable to create imported Connection: ${created.kind}`);
    }
  }
  const projected = projectHostConnections(await client.loadConnectionCatalog()).find(
    (item) => item.slug === connection.slug,
  );
  if (!projected) throw new Error('Imported Connection disappeared');
  return projected;
}

async function saveConnectionCredential(
  client: DesktopRuntimeHostClient,
  slug: string,
  kind: string,
  value: string,
): Promise<void> {
  const catalog = await client.loadConnectionCatalog();
  const connection = catalog.connections.find((item) => item.slug === slug);
  if (!connection) throw new Error(`Imported Connection not found: ${slug}`);
  const locator =
    kind === 'request_headers'
      ? ({
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'request_headers',
        } as const)
      : connectionCredentialLocator(connection);
  if (!locator || locator.kind !== kind) return;
  const current = await client.queryCredential(locator);
  const saved = await client.setCredential({
    locator,
    expected: current?.configured
      ? { credentialId: current.credentialId, revision: current.revision }
      : null,
    secret: value,
  });
  if (saved.kind !== 'committed') {
    throw new Error(`Unable to save imported Connection credential: ${saved.kind}`);
  }
}

function exportLocators(
  connections: readonly ConnectionCatalogEntry[],
): CredentialLocator[] {
  return [
    ...connections.flatMap((connection) => {
      const locator = connectionCredentialLocator(connection);
      const requestHeaders = {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'request_headers',
      } as const;
      return locator ? [locator, requestHeaders] : [requestHeaders];
    }),
    { scope: 'network_proxy', kind: 'password' },
    { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
  ];
}

function connectionCredentials(
  connections: readonly ConnectionCatalogEntry[],
  secrets: ReadonlyMap<string, string>,
): ExportedCredential[] {
  return connections.flatMap((connection) => {
    const locator = connectionCredentialLocator(connection);
    const secret = locator ? secrets.get(locatorKey(locator)) : undefined;
    const requestHeadersLocator = {
      scope: 'connection',
      connectionId: connection.connectionId,
      kind: 'request_headers',
    } as const;
    const requestHeaders = secrets.get(locatorKey(requestHeadersLocator));
    return [
      ...(locator && secret ? [{ slug: connection.slug, kind: locator.kind, value: secret }] : []),
      ...(requestHeaders
        ? [{ slug: connection.slug, kind: 'request_headers' as const, value: requestHeaders }]
        : []),
    ];
  });
}

function restoreHostSettingsSecrets(
  settings: AppSettings,
  secrets: ReadonlyMap<string, string>,
): AppSettings {
  const proxy = secrets.get(locatorKey({ scope: 'network_proxy', kind: 'password' })) ?? '';
  const webSearch =
    secrets.get(
      locatorKey({ scope: 'web_search', provider: 'tavily', kind: 'api_key' }),
    ) ?? '';
  return {
    ...settings,
    network: {
      proxy: { ...settings.network.proxy, password: proxy },
    },
    webSearch: {
      ...settings.webSearch,
      providers: {
        tavily: {
          ...settings.webSearch.providers.tavily,
          apiKey: webSearch,
        },
      },
    },
  };
}

function connectionCredentialLocator(
  connection: ConnectionCatalogEntry,
): Extract<CredentialLocator, { scope: 'connection' }> | null {
  const kind = PROVIDER_DEFAULTS[connection.providerType].authKind;
  if (kind === 'none') return null;
  return {
    scope: 'connection',
    connectionId: connection.connectionId,
    kind: kind === 'oauth_token' ? 'oauth_token' : 'api_key',
  };
}

function locatorKey(locator: CredentialLocator): string {
  return JSON.stringify(locator);
}

function sanitizeCategories(value: unknown): ConfigCategory[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isConfigCategory))];
}

function sanitizeStrategy(value: unknown): ConnectionConflictStrategy {
  return value === 'overwrite' ? 'overwrite' : 'skip';
}
