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
  EXPORT_PRIMARY_PROFILE_REF,
  type ConfigTransferDeps,
  type ExportedCredential,
  type ExportedProfileMeta,
  type V2ExportedConnection,
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
  type CredentialKind,
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

async function gatherRuntimeHostConfig(
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
    data.connections = v2ExportedConnections(catalog.connections);
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

/**
 * v2 connection payload: the projected connection plus non-secret Profile
 * metadata (export-local profileRefs, labels, weights, enable state) and the
 * declared routing mode. Secrets never ride here — they live in `credentials`
 * keyed by connectionSlug + profileRef + kind.
 */
function v2ExportedConnections(
  connections: readonly ConnectionCatalogEntry[],
): V2ExportedConnection[] {
  return connections.map((connection) => {
    const projected = projectHostConnections({
      revision: connection.revision,
      defaultTarget: null,
      connections: [connection],
    })[0];
    const routing = connection.credentialRouting;
    const profiles: ExportedProfileMeta[] | undefined = routing
      ? [
          {
            profileRef: EXPORT_PRIMARY_PROFILE_REF,
            profileId: connection.connectionId,
            label: 'primary',
            enabled: true,
            weight: 1,
            primary: true,
          },
          ...routing.profiles
            .filter((profile) => profile.profileId !== connection.connectionId)
            .map((profile, index) => ({
              profileRef: `secondary-${index}`,
              profileId: profile.profileId,
              label: profile.label,
              enabled: profile.enabled,
              weight: profile.weight,
              primary: false,
            })),
        ]
      : undefined;
    return {
      ...projected,
      ...(profiles === undefined ? {} : { credentialProfiles: profiles }),
      ...(routing === undefined ? {} : { routingMode: routing.mode }),
    };
  });
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
      get: deps.getSettings,
      update: deps.updateSettings,
    },
    credentialStore: {
      getSecret: async () => null,
      setSecret: (slug, kind, value) =>
        saveConnectionCredential(deps.client, slug, kind, value),
    },
    readMemory: () => readRuntimeHostMemoryDocument(deps.client, 'memory'),
    writeMemory: (content) =>
      replaceRuntimeHostMemoryDocument(deps.client, content),
    appVersion: deps.appVersion,
    profiles: profileTransferDeps(deps),
  };
}

function profileTransferDeps(
  deps: RuntimeHostConfigIpcDeps,
): NonNullable<ConfigTransferDeps['profiles']> {
  const requireConnection = async (slug: string) => {
    const catalog = await deps.client.loadConnectionCatalog();
    const connection = catalog.connections.find((candidate) => candidate.slug === slug);
    if (!connection) throw new Error(`No such Connection: ${slug}`);
    return connection;
  };
  return {
    list: async (slug) => {
      const connection = await requireConnection(slug);
      const readiness = await deps.client.queryCredentialProfileReadiness(
        connection.connectionId,
      );
      if (readiness.kind !== 'found') throw new Error('Connection no longer exists');
      return {
        connectionRevision: readiness.connectionRevision,
        routingMode: readiness.routingMode,
        readyCandidateCount: readiness.readyCandidateCount,
        profiles: readiness.profiles.map((profile) => ({
          profileId: profile.profileId,
          revision: profile.revision,
          label: profile.label,
          enabled: profile.enabled,
          weight: profile.weight,
          primary: profile.primary,
          credentialConfigured: profile.credentialConfigured,
          supportedModels: [...profile.supportedModels],
        })),
      };
    },
    create: async (slug, input) => {
      const connection = await requireConnection(slug);
      const created = await deps.client.createCredentialProfile({
        expected: { connectionId: connection.connectionId, revision: connection.revision },
        label: input.label,
        weight: input.weight,
      });
      if (created.kind !== 'committed') {
        throw new Error(`Unable to create imported Profile: ${created.kind}`);
      }
    },
    update: async (slug, input) => {
      const connection = await requireConnection(slug);
      const updated = await deps.client.updateCredentialProfile({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: connection.revision,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        },
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
      });
      if (updated.kind !== 'committed') {
        throw new Error(`Unable to update imported Profile: ${updated.kind}`);
      }
    },
    setEnabled: async (slug, input) => {
      const connection = await requireConnection(slug);
      const updated = await deps.client.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: connection.revision,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        },
        enabled: input.enabled,
      });
      if (updated.kind !== 'committed') {
        throw new Error(`Unable to set imported Profile state: ${updated.kind}`);
      }
    },
    setRoutingMode: async (slug, input) => {
      const connection = await requireConnection(slug);
      const updated = await deps.client.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: connection.revision },
        mode: input.mode,
      });
      if (updated.kind !== 'committed') {
        throw new Error(`Unable to set imported routing mode: ${updated.kind}`);
      }
    },
    setCredential: async (slug, input) => {
      const connection = await requireConnection(slug);
      const locator = {
        scope: 'connection_profile' as const,
        connectionId: connection.connectionId,
        profileId: input.profileId,
        kind: 'api_key' as const,
      };
      const current = await deps.client.queryCredential(locator);
      const saved = await deps.client.setCredential({
        locator,
        expected: current?.configured
          ? { credentialId: current.credentialId, revision: current.revision }
          : null,
        secret: input.secret,
      });
      if (saved.kind !== 'committed') {
        throw new Error(`Unable to save imported Profile credential: ${saved.kind}`);
      }
    },
    test: async (slug, input) => {
      const connection = await requireConnection(slug);
      const tested = await deps.client.testConnectionProfile(
        connection.connectionId,
        input.profileId,
      );
      if (tested.kind !== 'committed') {
        return { ok: false };
      }
      return { ok: tested.test.kind === 'verified' };
    },
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
      const profileLocators = profileCredentialLocators(connection);
      return locator
        ? [locator, requestHeaders, ...profileLocators]
        : [requestHeaders, ...profileLocators];
    }),
    { scope: 'network_proxy', kind: 'password' },
    { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
  ];
}

/** Secondary Profile credential locators in stable catalog order. */
function profileCredentialLocators(
  connection: ConnectionCatalogEntry,
): CredentialLocator[] {
  const routing = connection.credentialRouting;
  if (!routing) return [];
  const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
  if (authKind === 'none') return [];
  return routing.profiles
    .filter((profile) => profile.profileId !== connection.connectionId)
    .map((profile) => ({
      scope: 'connection_profile' as const,
      connectionId: connection.connectionId,
      profileId: profile.profileId,
      kind: authKind === 'oauth_token' ? ('oauth_token' as const) : ('api_key' as const),
    }));
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
    const routing = connection.credentialRouting;
    const secondaryEntries: ExportedCredential[] = routing
      ? routing.profiles
          .filter((profile) => profile.profileId !== connection.connectionId)
          .flatMap((profile, index) => {
            const profileLocator = {
              scope: 'connection_profile' as const,
              connectionId: connection.connectionId,
              profileId: profile.profileId,
              kind: (PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
                ? 'oauth_token'
                : 'api_key') as 'api_key' | 'oauth_token',
            };
            const profileSecret = secrets.get(locatorKey(profileLocator));
            return profileSecret
              ? [
                  {
                    slug: connection.slug,
                    profileRef: `secondary-${index}`,
                    kind: profileLocator.kind,
                    value: profileSecret,
                  },
                ]
              : [];
          })
      : [];
    return [
      ...(locator && secret
        ? [{ slug: connection.slug, profileRef: EXPORT_PRIMARY_PROFILE_REF, kind: locator.kind, value: secret }]
        : []),
      ...(requestHeaders
        ? [
            {
              slug: connection.slug,
              profileRef: EXPORT_PRIMARY_PROFILE_REF,
              kind: 'request_headers' as const,
              value: requestHeaders,
            },
          ]
        : []),
      ...secondaryEntries,
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
