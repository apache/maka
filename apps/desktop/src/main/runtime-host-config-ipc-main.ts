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
import { isDeepStrictEqual } from 'node:util';
import type { IpcMain } from 'electron';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import type { LlmConnection } from '@maka/core/llm-connections';
import { PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import {
  canonicalConnectionEffectiveBaseUrl,
  connectionCredentialTarget,
  type ConnectionCatalogEntry,
  type ConnectionCredentialTarget,
  type CredentialLocator,
  type NetworkProxyCredentialTarget,
  normalizeNetworkProxyCredentialTarget,
} from '@maka/core/runtime-policy';
import { networkProxyCredentialTarget } from '@maka/core/settings';
import {
  applyConfigImport,
  matchesCredentialConnection,
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
  runRuntimeHostSettingsExclusive,
  type RuntimeHostSettingsModule,
} from './runtime-host-settings-ipc-main.js';
import {
  buildConfigBundle,
  isConfigCategory,
  parseConfigBundle,
  serializeConfigBundle,
  type ConfigCategory,
  type ConfigBundle,
  type ConfigData,
  type ConnectionConflictStrategy,
} from '@maka/storage/config-transfer';

interface RuntimeHostConfigIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: DesktopRuntimeHostClient;
  readonly mainWindowController: ReturnType<typeof createMainWindowController>;
  readonly appVersion: string;
  readonly settingsModule: RuntimeHostSettingsModule;
  readonly emitConnectionsChanged: () => void;
}

interface RuntimeHostConfigGatherDeps {
  readonly client: DesktopRuntimeHostClient;
  readonly appVersion: string;
  readonly getSettings: () => Promise<AppSettings>;
}

interface RuntimeHostConfigTransferDeps {
  readonly client: DesktopRuntimeHostClient;
  readonly updateSettingsForConfigImport: (
    patch: UpdateAppSettingsInput,
  ) => Promise<{ skippedCredentials: number }>;
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
      const today = new Date().toISOString().slice(0, 10);
      const result = await deps.mainWindowController.showSaveDialog({
        title: '导出 Maka 配置',
        defaultPath: `maka-config-${today}.json`,
        filters: [{ name: 'Maka Config', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false as const, reason: 'canceled' as const };
      }
      const bundle = await runRuntimeHostSettingsExclusive(
        deps.settingsModule,
        (settings) =>
          gatherRuntimeHostConfig(categories, {
            client: deps.client,
            appVersion: deps.appVersion,
            getSettings: settings.get,
          }),
      );
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
      let importBundle: ConfigBundle;
      try {
        importBundle = adaptRuntimeHostConfigImport(parsed.bundle);
      } catch (error) {
        return {
          ok: false as const,
          reason: 'malformed' as const,
          message: error instanceof Error ? error.message : 'Invalid settings payload.',
        };
      }
      const imported = await runRuntimeHostSettingsExclusive(
        deps.settingsModule,
        (settings) =>
          applyConfigImport(
            importBundle,
            sanitizeStrategy(input?.strategy),
            runtimeHostTransferDeps(
              {
                client: deps.client,
                updateSettingsForConfigImport: settings.updateForConfigImport,
              },
            ),
          ),
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
  deps: RuntimeHostConfigGatherDeps,
) {
  const selected = new Set(categories);
  const data: ConfigData = {};
  let catalog = selected.has('connections') && !selected.has('credentials')
    ? await deps.client.loadConnectionCatalog()
    : undefined;
  let exported: Awaited<ReturnType<typeof exportConfigurationCredentials>> = {
    credentials: [],
    connectionStale: false,
    proxyTarget: undefined,
  };
  let settings: AppSettings | undefined;
  if (selected.has('credentials')) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      catalog = await deps.client.loadConnectionCatalog();
      exported = await exportConfigurationCredentials(
        deps.client,
        exportLocators(catalog.connections),
      );
      if (exported.connectionStale) {
        if (attempt === 2) {
          throw new Error('Connection targets kept changing while credentials were exported');
        }
        continue;
      }
      if (
        selected.has('settings') &&
        exported.proxyTarget &&
        !isDeepStrictEqual(
          exported.proxyTarget,
          networkProxyCredentialTarget((settings = await deps.getSettings()).network.proxy),
        )
      ) {
        if (attempt === 2) {
          throw new Error('Proxy target kept changing while credentials were exported');
        }
        continue;
      }
      if (selected.has('settings') && !settings) settings = await deps.getSettings();
      break;
    }
  } else if (selected.has('settings')) {
    settings = await deps.getSettings();
  }
  const secrets = new Map(
    exported.credentials.map((entry) => [locatorKey(entry.locator), entry.secret]),
  );

  if (selected.has('connections') && catalog) {
    data.connections = projectHostConnections(catalog);
  }
  // Schema v1 stores the network-proxy password and Tavily key in the
  // settings payload. Keep a credentials-only request lossless by making the
  // dependency explicit in the generated bundle.
  if (selected.has('settings')) {
    if (!settings) throw new Error('Settings snapshot was not gathered');
    data.settings = selected.has('credentials')
      ? restoreHostSettingsSecrets(settings, secrets)
      : stripSettingsSecretsForExport(settings);
  } else if (selected.has('credentials')) {
    const settingsSecrets = projectHostSettingsSecrets(exported.proxyTarget, secrets);
    if (settingsSecrets) data.settings = settingsSecrets;
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
  requests: readonly CredentialExportRequest[],
) {
  const credentials: Array<{
    locator: CredentialLocator;
    secret: string;
    proxyTarget?: NetworkProxyCredentialTarget;
  }> = [];
  let proxyTarget: NetworkProxyCredentialTarget | undefined;
  for (const request of requests) {
    const exported = await client.exportConfigurationCredentials(request);
    if (exported.connectionStale) {
      return { credentials: [], connectionStale: true, proxyTarget: undefined };
    }
    if (exported.credential) {
      if (
        exported.credential.locator.scope === 'network_proxy' &&
        !exported.credential.proxyTarget
      ) {
        throw new Error('Runtime Host omitted the proxy credential target binding');
      }
      if (exported.credential.proxyTarget) {
        proxyTarget = exported.credential.proxyTarget;
      }
      credentials.push({
        locator: exported.credential.locator,
        secret: Buffer.from(exported.credential.secretBase64, 'base64').toString('utf8'),
        ...(exported.credential.proxyTarget === undefined
          ? {}
          : { proxyTarget: exported.credential.proxyTarget }),
      });
    }
  }
  return { credentials, connectionStale: false, proxyTarget };
}

interface CredentialExportRequest {
  readonly locator: CredentialLocator;
  readonly expectedConnection?: ConnectionCredentialTarget;
}

function runtimeHostTransferDeps(
  deps: RuntimeHostConfigTransferDeps,
): ConfigTransferDeps {
  return {
    connectionStore: {
      list: async () =>
        projectHostConnections(await deps.client.loadConnectionCatalog()),
      save: (connection) => saveConnection(deps.client, connection),
    },
    settingsStore: {
      update: async (patch) => {
        const result = await deps.updateSettingsForConfigImport(patch);
        return { skippedCredentials: result.skippedCredentials };
      },
    },
    credentialStore: {
      setSecret: (entry) => saveConnectionCredential(deps.client, entry),
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
  entry: ExportedCredential,
): Promise<boolean> {
  const catalog = await client.loadConnectionCatalog();
  const connection = catalog.connections.find((item) => item.slug === entry.slug);
  if (!connection || !matchesCredentialConnection(entry.connection, connection)) return false;
  const locator =
    entry.kind === 'request_headers'
      ? ({
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'request_headers',
        } as const)
      : connectionCredentialLocator(connection);
  if (!locator || locator.kind !== entry.kind) return false;
  const current = await client.queryCredential(locator);
  const saved = await client.setCredential({
    locator,
    expected: current?.configured
      ? { credentialId: current.credentialId, revision: current.revision }
      : null,
    expectedConnection: connectionCredentialTarget(connection),
    secret: entry.value,
  });
  return saved.kind === 'committed';
}

function exportLocators(
  connections: readonly ConnectionCatalogEntry[],
): CredentialExportRequest[] {
  return [
    ...connections.flatMap((connection) => {
      const locator = connectionCredentialLocator(connection);
      const requestHeaders = {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'request_headers',
      } as const;
      const expectedConnection = connectionCredentialTarget(connection);
      return (locator ? [locator, requestHeaders] : [requestHeaders]).map(
        (connectionLocator) => ({
          locator: connectionLocator,
          expectedConnection,
        }),
      );
    }),
    { locator: { scope: 'network_proxy', kind: 'password' } },
    { locator: { scope: 'web_search', provider: 'tavily', kind: 'api_key' } },
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
      ...(locator && secret
        ? [{
            slug: connection.slug,
            kind: locator.kind,
            value: secret,
            connection: credentialConnectionBinding(connection),
          }]
        : []),
      ...(requestHeaders
        ? [{
            slug: connection.slug,
            kind: 'request_headers' as const,
            value: requestHeaders,
            connection: credentialConnectionBinding(connection),
          }]
        : []),
    ];
  });
}

function credentialConnectionBinding(
  connection: ConnectionCatalogEntry,
): NonNullable<ExportedCredential['connection']> {
  return {
    providerType: connection.providerType,
    effectiveBaseUrl: canonicalConnectionEffectiveBaseUrl(connection),
  };
}

function restoreHostSettingsSecrets(
  settings: AppSettings,
  secrets: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const proxy = secrets.get(locatorKey({ scope: 'network_proxy', kind: 'password' })) ?? '';
  const webSearch =
    secrets.get(
      locatorKey({ scope: 'web_search', provider: 'tavily', kind: 'api_key' }),
    ) ?? '';
  const {
    passwordConfigured: _passwordConfigured,
    ...proxySettings
  } = settings.network.proxy as typeof settings.network.proxy & {
    passwordConfigured?: boolean;
  };
  return {
    ...settings,
    network: {
      proxy: { ...proxySettings, password: proxy },
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

function projectHostSettingsSecrets(
  proxyTarget: NetworkProxyCredentialTarget | undefined,
  secrets: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const proxy = secrets.get(
    locatorKey({ scope: 'network_proxy', kind: 'password' }),
  );
  const tavily = secrets.get(
    locatorKey({ scope: 'web_search', provider: 'tavily', kind: 'api_key' }),
  );
  if (proxy === undefined && tavily === undefined) return undefined;

  return {
    ...(proxy === undefined || proxyTarget === undefined
      ? {}
      : {
          network: {
            proxy: {
              password: proxy,
              credentialTarget: proxyTarget,
            },
          },
        }),
    ...(tavily === undefined
      ? {}
      : {
          webSearch: {
            providers: {
              tavily: { apiKey: tavily },
            },
          },
        }),
  };
}

/** Convert schema-v1 wire secrets into the write-only Runtime Host contract. */
export function adaptRuntimeHostConfigImport(bundle: ConfigBundle): ConfigBundle {
  const settings = bundle.data.settings;
  if (!isRecord(settings)) return bundle;
  const network = settings.network;
  if (!isRecord(network) || !isRecord(network.proxy)) return bundle;

  const wireProxy = network.proxy;
  const credentialTarget = wireProxy.credentialTarget;
  const passwordPresent = Object.prototype.hasOwnProperty.call(
    wireProxy,
    'password',
  );
  const password = wireProxy.password;
  const includesCredentials = bundle.includedData.includes('credentials');
  if (
    includesCredentials &&
    passwordPresent &&
    typeof password !== 'string'
  ) {
    throw new Error('Proxy password in imported settings must be a string.');
  }
  if (
    includesCredentials &&
    typeof password === 'string' &&
    password.length > 0 &&
    wireProxy.authEnabled === false
  ) {
    throw new Error(
      'Cannot import a proxy password while proxy authentication is disabled.',
    );
  }
  if (
    includesCredentials &&
    typeof password === 'string' &&
    password.length > 0 &&
    credentialTarget === undefined
  ) {
    throw new Error('Proxy password import requires a target binding.');
  }

  const {
    password: _password,
    passwordConfigured: _passwordConfigured,
    credential: _credential,
    credentialTarget: _credentialTarget,
    ...ordinaryProxy
  } = wireProxy;
  const proxy = {
    ...ordinaryProxy,
    ...(includesCredentials && passwordPresent
      ? {
          credential:
            (password as string).length === 0
              ? ({ kind: 'delete' } as const)
              : ({
                  kind: 'replace',
                  secret: password as string,
                  ...(credentialTarget === undefined
                    ? {}
                    : {
                        expectedTarget: normalizeNetworkProxyCredentialTarget(
                          credentialTarget,
                        ),
                      }),
                } as const),
        }
      : {}),
  };

  return {
    ...bundle,
    data: {
      ...bundle.data,
      settings: {
        ...settings,
        network: {
          ...network,
          proxy,
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectionCredentialLocator(
  connection: ConnectionCatalogEntry,
): Extract<CredentialLocator, { scope: 'connection' }> | null {
  const kind = PROVIDER_REGISTRY[connection.providerType].authKind;
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
