import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  connectionEnabledModelIds,
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
  PROVIDER_DEFAULTS,
  providerSupportsModelDiscovery,
  type LlmConnection,
} from '@maka/core/llm-connections';
import type {
  ConnectionCatalogEntry,
  ConnectionModelDiscoveryResult,
  ConnectionTestSummary,
  CredentialLocator,
  RuntimePolicy,
} from '@maka/core/runtime-policy';
import type { AppSettings } from '@maka/core/settings';
import { createConnectionStore } from '@maka/storage/connection-store';
import { createFileCredentialStore } from '@maka/storage/credential-store';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import { createSettingsStore } from '@maka/storage/settings-store';
const JOURNAL_FILE = '.runtime-host-m5-migration.json';
const LEGACY_FILES = ['llm-connections.json', 'credentials.json', 'settings.json'] as const;

interface MigrationJournal {
  readonly version: 1;
  readonly state: 'importing';
}

export async function migrateLegacyRuntimePolicy(input: {
  readonly workspaceRoot: string;
  readonly legacyConfigurationRoot?: string;
  readonly stores: RuntimePolicyStoresWriter;
}): Promise<void> {
  const journalPath = join(input.workspaceRoot, JOURNAL_FILE);
  const legacyRoot = input.legacyConfigurationRoot ?? input.workspaceRoot;
  const journal = await readJournal(journalPath);
  const [catalog, vault, policy] = await Promise.all([
    input.stores.connectionCatalog.getSnapshot(),
    input.stores.credentialVault.getSnapshot(),
    input.stores.runtimePolicy.getSnapshot(),
  ]);
  const establishedHostState =
    catalog.revision !== 0 ||
    catalog.connections.length !== 0 ||
    vault.revision !== 0 ||
    vault.entries.length !== 0 ||
    policy.revision !== 0;
  const legacySettingsPath = join(legacyRoot, 'settings.json');
  const settings = (await fileExists(legacySettingsPath))
    ? await createSettingsStore(legacyRoot).get()
    : undefined;
  if (await isVersionOnePolicy(join(input.workspaceRoot, 'runtime-policy.json'))) {
    await importSubagents(input.stores, settings?.subagents ?? { presets: [] });
  }
  if (!journal) {
    if (establishedHostState) return;
    if (!(await hasLegacyState(legacyRoot))) return;
    await writeJournal(journalPath);
  }

  const connectionStore = createConnectionStore(legacyRoot);
  const credentialStore = createFileCredentialStore(legacyRoot);
  const legacyConnections = (await connectionStore.list()).map(normalizeLegacyConnection);
  const imported = await importConnections(input.stores, legacyConnections);
  await importConnectionCredentials(input.stores, credentialStore, legacyConnections, imported);
  if (settings) {
    await importRuntimePolicy(input.stores, settings);
    await importSettingsCredentials(input.stores, settings);
  }
  await importConnectionEffects(input.stores, legacyConnections, imported);
  await importDefaultTarget(
    input.stores,
    imported,
    legacyConnections,
    await connectionStore.getDefault(),
  );
  await rm(journalPath, { force: true });
}

async function importSubagents(
  stores: RuntimePolicyStoresWriter,
  subagents: RuntimePolicy['subagents'],
): Promise<void> {
  const current = await stores.runtimePolicy.getSnapshot();
  const result = await stores.runtimePolicy.mutate({
    expectedRevision: current.revision,
    operation: { kind: 'set_subagents', value: subagents },
  });
  if (result.kind !== 'committed') {
    throw new Error('Legacy subagent migration lost its exclusive revision');
  }
}

async function importConnections(
  stores: RuntimePolicyStoresWriter,
  legacyConnections: readonly LlmConnection[],
): Promise<Map<string, ConnectionCatalogEntry>> {
  let catalog = await stores.connectionCatalog.getSnapshot();
  for (const legacy of legacyConnections) {
    if (catalog.connections.some(({ slug }) => slug === legacy.slug)) continue;
    const result = await stores.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: legacy.slug,
        name: legacy.name,
        providerType: legacy.providerType,
        ...(legacy.baseUrl ? { baseUrl: legacy.baseUrl } : {}),
        enabled: legacy.enabled,
        enabledModelIds: connectionEnabledModelIds(legacy),
      },
    });
    if (result.kind !== 'committed') {
      throw new Error(`Legacy Connection migration failed: ${result.kind}`);
    }
    catalog = result.snapshot;
  }
  return new Map(catalog.connections.map((connection) => [connection.slug, connection]));
}

async function importConnectionCredentials(
  stores: RuntimePolicyStoresWriter,
  credentialStore: ReturnType<typeof createFileCredentialStore>,
  legacyConnections: readonly LlmConnection[],
  imported: ReadonlyMap<string, ConnectionCatalogEntry>,
): Promise<void> {
  for (const legacy of legacyConnections) {
    const connection = imported.get(legacy.slug);
    if (!connection) throw new Error(`Imported Connection is missing: ${legacy.slug}`);
    const authKind = PROVIDER_DEFAULTS[legacy.providerType].authKind;
    const credentialKind: 'api_key' | 'oauth_token' | null =
      authKind === 'oauth_token' ? 'oauth_token' : authKind === 'none' ? null : 'api_key';
    if (!credentialKind) continue;
    const secret = await credentialStore.getSecret(legacy.slug, credentialKind);
    if (!secret) continue;
    await setCredential(
      stores,
      {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: credentialKind,
      },
      secret,
      'migration',
    );
  }
}

async function importConnectionEffects(
  stores: RuntimePolicyStoresWriter,
  legacyConnections: readonly LlmConnection[],
  imported: ReadonlyMap<string, ConnectionCatalogEntry>,
): Promise<void> {
  for (const legacy of legacyConnections) {
    const connection = imported.get(legacy.slug);
    if (!connection) continue;
    if (!(await canImportConnectionEffects(stores, legacy, connection))) continue;
    const modelResult = legacyModelResult(legacy);
    if (modelResult) {
      const prepared = await stores.operations.beginModelFetch(connection.connectionId);
      if (prepared.kind !== 'ready') {
        throw new Error(`Legacy Connection model inventory migration failed: ${prepared.kind}`);
      }
      const completed = await stores.operations.completeModelFetch(prepared.ticket, modelResult);
      if (completed.kind !== 'committed') {
        throw new Error('Legacy Connection model inventory was superseded during migration');
      }
    }
    const test = legacyTestSummary(legacy);
    if (!test) continue;
    const prepared = await stores.operations.beginConnectionTest(
      connection.connectionId,
      legacy.defaultModel || null,
    );
    if (prepared.kind !== 'ready') {
      throw new Error(`Legacy Connection health migration failed: ${prepared.kind}`);
    }
    const completed = await stores.operations.completeConnectionTest(prepared.ticket, test);
    if (completed.kind !== 'committed') {
      throw new Error('Legacy Connection health was superseded during migration');
    }
  }
}

async function canImportConnectionEffects(
  stores: RuntimePolicyStoresWriter,
  legacy: LlmConnection,
  connection: ConnectionCatalogEntry,
): Promise<boolean> {
  if (!providerSupportsModelDiscovery(legacy.providerType)) return false;
  const authKind = PROVIDER_DEFAULTS[legacy.providerType].authKind;
  if (authKind === 'none') return true;
  const result = await stores.credentialVault.getStatus({
    scope: 'connection',
    connectionId: connection.connectionId,
    kind: authKind === 'oauth_token' ? 'oauth_token' : 'api_key',
  });
  return result.kind === 'status' && result.status.configured;
}

async function importDefaultTarget(
  stores: RuntimePolicyStoresWriter,
  imported: ReadonlyMap<string, ConnectionCatalogEntry>,
  legacyConnections: readonly LlmConnection[],
  defaultSlug: string | null,
): Promise<void> {
  if (!defaultSlug) return;
  const connection = imported.get(defaultSlug);
  const legacy = legacyConnections.find(({ slug }) => slug === defaultSlug);
  const modelId = legacy?.defaultModel || connection?.enabledModelIds[0];
  if (!connection || !modelId || !connection.enabledModelIds.includes(modelId)) return;
  const catalog = await stores.connectionCatalog.getSnapshot();
  const result = await stores.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: catalog.revision,
    target: { connectionId: connection.connectionId, modelId },
  });
  if (result.kind !== 'committed') {
    throw new Error(`Legacy default Connection migration failed: ${result.kind}`);
  }
}

async function importRuntimePolicy(
  stores: RuntimePolicyStoresWriter,
  settings: AppSettings,
): Promise<void> {
  const proxy = settings.network.proxy;
  const values: RuntimePolicy = {
    networkProxy: {
      enabled: proxy.enabled,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      authEnabled: proxy.authEnabled,
      username: proxy.username,
      bypassList: [...proxy.bypassList],
      autoBypassDomains: [...proxy.autoBypassDomains],
    },
    personalization: {
      displayName: settings.personalization.displayName,
      assistantTone: settings.personalization.assistantTone,
    },
    memory: settings.localMemory,
    workspaceInstructions: settings.workspaceInstructions,
    privacy: settings.privacy,
    chatDefaults: settings.chatDefaults,
    webSearch: {
      enabled: settings.webSearch.enabled,
      defaultProvider: settings.webSearch.defaultProvider,
    },
    subagents: settings.subagents,
  };
  const operations = [
    { kind: 'set_network_proxy' as const, value: values.networkProxy },
    { kind: 'set_personalization' as const, value: values.personalization },
    { kind: 'set_memory' as const, value: values.memory },
    { kind: 'set_workspace_instructions' as const, value: values.workspaceInstructions },
    { kind: 'set_privacy' as const, value: values.privacy },
    { kind: 'set_chat_defaults' as const, value: values.chatDefaults },
    { kind: 'set_web_search' as const, value: values.webSearch },
    { kind: 'set_subagents' as const, value: values.subagents },
  ];
  for (const operation of operations) {
    const current = await stores.runtimePolicy.getSnapshot();
    const result = await stores.runtimePolicy.mutate({
      expectedRevision: current.revision,
      operation,
    });
    if (result.kind !== 'committed') {
      throw new Error('Legacy Runtime policy migration lost its exclusive revision');
    }
  }
}

async function importSettingsCredentials(
  stores: RuntimePolicyStoresWriter,
  settings: AppSettings,
): Promise<void> {
  const proxyPassword = settings.network.proxy.password;
  if (proxyPassword) {
    await setCredential(stores, { scope: 'network_proxy', kind: 'password' }, proxyPassword);
  }
  const tavilyApiKey = settings.webSearch.providers.tavily.apiKey;
  if (tavilyApiKey) {
    await setCredential(
      stores,
      { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
      tavilyApiKey,
    );
  }
}

async function setCredential(
  stores: RuntimePolicyStoresWriter,
  locator: CredentialLocator,
  secret: string,
  authority: 'client' | 'migration' = 'client',
): Promise<void> {
  const current = await stores.credentialVault.getStatus(locator);
  if (current.kind === 'connection_not_found') {
    throw new Error('Legacy credential refers to a missing Connection');
  }
  if (current.status.configured) return;
  const input = { locator, expected: null, secret };
  const result =
    authority === 'migration'
      ? await stores.operations.importConnectionCredential(input)
      : await stores.credentialVault.set(input);
  if (result.kind !== 'committed') {
    throw new Error(`Legacy credential migration failed: ${result.kind}`);
  }
}

function legacyModelResult(connection: LlmConnection): ConnectionModelDiscoveryResult | null {
  if (
    connection.models?.length &&
    connection.modelSource &&
    connection.modelsFetchedAt !== undefined
  ) {
    return {
      models: connection.models,
      source: connection.modelSource,
      fetchedAt: connection.modelsFetchedAt,
    };
  }
  const enabledModelIds = connectionEnabledModelIds(connection);
  return enabledModelIds.length > 0
    ? {
        models: enabledModelIds.map((id) => ({ id })),
        source: 'fallback',
        fetchedAt: connection.updatedAt,
      }
    : null;
}

function legacyTestSummary(connection: LlmConnection): ConnectionTestSummary | null {
  if (!connection.lastTestStatus || !connection.lastTestAt) return null;
  return {
    status: connection.lastTestStatus,
    checkedAt: connection.lastTestAt,
    ...(connection.lastTestStatus === 'needs_reauth'
      ? { errorClass: 'auth' as const }
      : connection.lastTestStatus === 'error'
        ? { errorClass: 'unknown' as const }
        : {}),
  };
}

function normalizeLegacyConnection(connection: LlmConnection): LlmConnection {
  const isBootstrapBase =
    connection.slug === 'opencode-free' &&
    connection.name === 'OpenCode Free' &&
    connection.providerType === 'opencode-free' &&
    connection.baseUrl === undefined &&
    connection.enabled === true &&
    connection.models === undefined;
  if (!isBootstrapBase) return connection;
  const legacyV1 =
    connection.defaultModel === 'big-pickle' &&
    sameStringList(connection.enabledModelIds, ['big-pickle']) &&
    connection.extras === undefined;
  const legacyV2 =
    connection.defaultModel === OPENCODE_FREE_DEFAULT_MODEL &&
    sameStringList(connection.enabledModelIds, [OPENCODE_FREE_DEFAULT_MODEL]) &&
    bootstrapVersion(connection) === 2;
  if (!legacyV1 && !legacyV2) return connection;
  return {
    ...connection,
    defaultModel: OPENCODE_FREE_DEFAULT_MODEL,
    enabledModelIds: [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS],
  };
}

function bootstrapVersion(connection: LlmConnection): number | undefined {
  const extras = connection.extras;
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return undefined;
  if (Object.keys(extras).length !== 1) return undefined;
  const bootstrap = extras.makaBootstrap;
  if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)) return undefined;
  const record = bootstrap as { id?: unknown; version?: unknown };
  if (Object.keys(record).length !== 2 || record.id !== 'opencode-free') return undefined;
  return typeof record.version === 'number' ? record.version : undefined;
}

function sameStringList(
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  return actual?.length === expected.length && actual.every((id, index) => id === expected[index]);
}

async function hasLegacyState(workspaceRoot: string): Promise<boolean> {
  const results = await Promise.all(
    LEGACY_FILES.map((file) => fileExists(join(workspaceRoot, file))),
  );
  return results.some(Boolean);
}

async function readJournal(path: string): Promise<MigrationJournal | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(contents) as Partial<MigrationJournal>;
  if (value.version !== 1 || value.state !== 'importing') {
    throw new Error('Invalid Runtime Host migration journal');
  }
  return { version: 1, state: 'importing' };
}

async function writeJournal(path: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, state: 'importing' } satisfies MigrationJournal)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

async function isVersionOnePolicy(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion?: unknown };
    return value.schemaVersion === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
