import type {
  ConnectionTestResult,
  CreateConnectionInput,
  LlmConnection,
  SavedRequestHeaders,
  UpdateConnectionInput,
} from '@maka/core/llm-connections';
import type { QuotaSnapshot } from '@maka/core/oauth-subscription';
import {
  connectionEnabledModelIds,
  defaultEnabledModelIdsWhenOmitted,
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
} from '@maka/core/llm-connections';
import { normalizeRelayModelProfiles } from '@maka/core/model-thinking';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import { normalizeRequestHeaderUpdates } from '@maka/core/runtime-policy';
import type {
  ConnectionProfileModelFetchResult,
  ConnectionProfileTestRunResult,
  ConnectionTestRunResult,
  CredentialProfileQueryResult,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import {
  normalizeConnectionBaseUrlForIpc,
  normalizeConnectionPatchSecretsForIpc,
  normalizeConnectionSlugForIpc,
  normalizeCreateConnectionInputForIpc,
} from './connections-ipc-validation.js';

type HostConnectionsClient = Pick<
  DesktopRuntimeHostClient,
  | 'createConnection'
  | 'createCredentialProfile'
  | 'deleteCredential'
  | 'fetchConnectionModels'
  | 'fetchConnectionProfileModels'
  | 'fetchOAuthAccountUsage'
  | 'getConnectionRequestHeaders'
  | 'loadConnectionCatalog'
  | 'queryCredential'
  | 'queryCredentialProfileReadiness'
  | 'removeConnection'
  | 'removeCredentialProfile'
  | 'replaceConnectionRequestHeaders'
  | 'setCredential'
  | 'setCredentialProfileEnabled'
  | 'setCredentialRoutingMode'
  | 'setDefaultConnectionTarget'
  | 'testConnection'
  | 'testConnectionProfile'
  | 'updateConnection'
  | 'updateCredentialProfile'
>;

export interface CredentialProfileReadinessView {
  readonly connectionRevision: number;
  readonly routingMode: 'legacy_primary' | 'balanced';
  readonly routingStrategy: 'smooth_weighted_round_robin' | 'priority_failover';
  readonly readyCandidateCount: number;
  readonly profiles: ReadonlyArray<{
    readonly profileId: string;
    readonly revision: number;
    readonly label: string;
    readonly enabled: boolean;
    readonly weight: number;
    readonly primary: boolean;
    readonly credentialConfigured: boolean;
    readonly accountHint?: string;
    readonly lastTest:
      | {
          readonly status: 'verified' | 'needs_reauth' | 'error';
          readonly checkedAt: string;
          readonly errorClass?: string;
        }
      | null;
    readonly supportedModels: readonly string[];
    readonly circuit:
      | {
          readonly state: 'closed' | 'open' | 'half_open' | 'invalid';
          readonly blockedUntil: number | null;
          readonly nextProbeAt: number | null;
        }
      | null;
  }>;
};

export type CredentialProfileUsageView =
  | { readonly kind: 'available'; readonly quota: QuotaSnapshot }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'unsupported_provider'
        | 'credential_unavailable'
        | 'provider_rejected'
        | 'provider_unavailable'
        | 'invalid_response';
    };

export function projectCredentialProfileReadiness(
  result: Extract<CredentialProfileQueryResult, { readonly kind: 'found' }>,
): CredentialProfileReadinessView {
  return {
    connectionRevision: result.connectionRevision,
    routingMode: result.routingMode,
    routingStrategy: result.routingStrategy,
    readyCandidateCount: result.readyCandidateCount,
    profiles: result.profiles.map((profile) => ({
      profileId: profile.profileId,
      revision: profile.revision,
      label: profile.label,
      enabled: profile.enabled,
      weight: profile.weight,
      primary: profile.primary,
      credentialConfigured: profile.credentialConfigured,
      ...(profile.accountHint ? { accountHint: profile.accountHint } : {}),
      lastTest: profile.lastTest,
      supportedModels: [...profile.supportedModels],
      circuit: profile.circuit,
    })),
  };
}

export interface RuntimeHostConnectionsIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: HostConnectionsClient;
  readonly emitConnectionListChanged: () => void;
}

export function registerRuntimeHostConnectionsIpc(
  deps: RuntimeHostConnectionsIpcDeps,
): void {
  const snapshot = () => deps.client.loadConnectionCatalog();
  const projected = async () => projectHostConnections(await snapshot());

  handleReconnectableRead(deps.ipcMain, 'connections:list', projected);
  handleReconnectableRead(deps.ipcMain, 'connections:getDefault', async () => {
    const catalog = await snapshot();
    return defaultConnection(catalog)?.slug ?? null;
  });
  handleReconnectableRead(deps.ipcMain, 'connections:hasSecret', async (_event, slug: unknown) => {
    const catalog = await snapshot();
    const connection = requireConnection(catalog, slug);
    if (!providerAuthRequiresSecret(connection.providerType)) return true;
    return (
      (await deps.client.queryCredential(connectionCredential(connection)))
        ?.configured === true
    );
  });
  handleReconnectableRead(
    deps.ipcMain,
    'connections:getRequestHeaders',
    async (_event, slug: unknown) => {
      const connection = requireConnection(await snapshot(), slug);
      const result = await deps.client.getConnectionRequestHeaders(connection.connectionId);
      if (result.kind !== 'found') throw new Error('Connection no longer exists');
      return { names: result.names } satisfies SavedRequestHeaders;
    },
  );
  deps.ipcMain.handle(
    'connections:setRequestHeaders',
    async (_event, slug: unknown, rawUpdates: unknown) => {
      const connection = requireConnection(await snapshot(), slug);
      const result = await deps.client.replaceConnectionRequestHeaders(
        connection.connectionId,
        normalizeRequestHeaderUpdates(rawUpdates),
      );
      if (result.kind === 'connection_not_found') throw new Error('Connection no longer exists');
      if (result.kind === 'committed') deps.emitConnectionListChanged();
      return { names: result.names } satisfies SavedRequestHeaders;
    },
  );
  deps.ipcMain.handle('connections:setDefault', async (_event, slug: unknown) => {
    const catalog = await snapshot();
    const target = slug === null
      ? null
      : defaultTargetForConnection(requireConnection(catalog, slug));
    requireCommitted(
      await deps.client.setDefaultConnectionTarget(catalog.revision, target),
      'set default Connection',
    );
    deps.emitConnectionListChanged();
  });
  deps.ipcMain.handle('connections:setDefaultModel', async (_event, input: unknown) => {
    const catalog = await snapshot();
    const target = input === null ? null : explicitDefaultTarget(catalog, input);
    requireCommitted(
      await deps.client.setDefaultConnectionTarget(catalog.revision, target),
      'set default model',
    );
    deps.emitConnectionListChanged();
  });
  deps.ipcMain.handle('connections:create', async (_event, raw: unknown) => {
    const input = normalizeCreateInput(raw);
    const catalog = await snapshot();
    // Profiles ride as the typed field end to end — nothing free-form
    // crosses to the host.
    const relayModelProfiles = input.relayModelProfiles;
    const created = await deps.client.createConnection(catalog.revision, {
      slug: input.slug,
      name: input.name,
      providerType: input.providerType,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      enabled: true,
      enabledModelIds: connectionEnabledModelIds({
        defaultModel: input.defaultModel,
        enabledModelIds: defaultEnabledModelIdsWhenOmitted(input.providerType),
      }),
      ...(relayModelProfiles === undefined ? {} : { relayModelProfiles }),
      ...(input.requestBodyOverlay === undefined
        ? {}
        : { requestBodyOverlay: input.requestBodyOverlay }),
    });
    if (created.kind !== 'committed') {
      throw new Error(`Unable to create Connection: ${created.kind}`);
    }
    try {
      const entry = requireConnection(await snapshot(), input.slug);
      if (input.apiKey) {
        const credential = await deps.client.setCredential({
          locator: connectionCredential(entry),
          expected: null,
          secret: input.apiKey,
        });
        if (credential.kind !== 'committed') {
          throw new Error(`Unable to save Connection credential: ${credential.kind}`);
        }
      }
      if (input.requestHeaders && Object.keys(input.requestHeaders).length > 0) {
        const requestHeaders = await deps.client.replaceConnectionRequestHeaders(
          entry.connectionId,
          Object.entries(input.requestHeaders).map(([name, value]) => ({ name, value })),
        );
        if (requestHeaders.kind !== 'committed') {
          throw new Error(`Unable to save custom request headers: ${requestHeaders.kind}`);
        }
      }
    } catch (error) {
      await deps.client.removeConnection(created.connection).catch(() => undefined);
      throw error;
    }
    deps.emitConnectionListChanged();
    return requireProjectedConnection(await snapshot(), input.slug);
  });
  deps.ipcMain.handle('connections:update', async (_event, rawSlug: unknown, rawPatch: unknown) => {
    const catalog = await snapshot();
    const current = requireConnection(catalog, rawSlug);
    const patch = normalizeUpdateInput(current, rawPatch);
    const updated = await deps.client.updateConnection(
      { connectionId: current.connectionId, revision: current.revision },
      {
        name: patch.name ?? current.name,
        ...(patch.baseUrl === undefined
          ? current.baseUrl === undefined
            ? {}
            : { baseUrl: current.baseUrl }
          : patch.baseUrl === ''
            ? {}
            : { baseUrl: patch.baseUrl }),
        enabled: patch.enabled ?? current.enabled,
        enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
        // Tri-state: a patch that mentions profiles re-normalizes them (empty
        // normalization = clear); a patch without profiles omits the key
        // entirely, which the store reads as "leave the table alone".
        ...(patch.relayModelProfiles === undefined
          ? {}
          : { relayModelProfiles: normalizeRelayModelProfiles(patch.relayModelProfiles) ?? null }),
        ...(patch.requestBodyOverlay === undefined
          ? {}
          : { requestBodyOverlay: patch.requestBodyOverlay }),
      },
    );
    if (updated.kind !== 'committed') {
      throw new Error(`Unable to update Connection: ${updated.kind}`);
    }
    if (patch.apiKey !== undefined) await updateCredential(deps.client, current, patch.apiKey);
    if (patch.defaultModel !== undefined) {
      const latest = await snapshot();
      const entry = requireConnection(latest, current.slug);
      const target = patch.defaultModel
        ? { connectionId: entry.connectionId, modelId: patch.defaultModel }
        : latest.defaultTarget?.connectionId === entry.connectionId
          ? null
          : latest.defaultTarget;
      requireCommitted(
        await deps.client.setDefaultConnectionTarget(latest.revision, target),
        'update default model',
      );
    }
    deps.emitConnectionListChanged();
    return requireProjectedConnection(await snapshot(), current.slug);
  });
  deps.ipcMain.handle('connections:delete', async (_event, slug: unknown) => {
    // OAuth/model-fetch can bump the connection revision under the UI. Retry
    // on connection_stale with a fresh snapshot so delete does not fail with a
    // opaque "service unavailable" after the user already confirmed.
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const catalog = await snapshot();
      let current: ReturnType<typeof requireConnection>;
      try {
        current = requireConnection(catalog, slug);
      } catch (error) {
        // Only treat a missing slug as success. Invalid input must still fail.
        if (error instanceof Error && error.message.startsWith('No such Connection:')) {
          deps.emitConnectionListChanged();
          return;
        }
        throw error;
      }
      const result = await deps.client.removeConnection({
        connectionId: current.connectionId,
        revision: current.revision,
      });
      // RemoveCatalogConnectionResult is only committed | connection_stale.
      if (result.kind === 'committed') {
        deps.emitConnectionListChanged();
        return;
      }
      if (attempt < maxAttempts - 1) {
        continue;
      }
      // English so renderer locale mapping (provider-panel-shared) can choose zh/en.
      throw new Error('Unable to delete Connection: connection_stale');
    }
  });
  deps.ipcMain.handle('connections:fetchModels', async (_event, slug: unknown) => {
    const current = requireConnection(await snapshot(), slug);
    const result = await deps.client.fetchConnectionModels(current.connectionId);
    if (result.kind !== 'committed') {
      throw new Error(`Unable to fetch Connection models: ${result.kind}`);
    }
    deps.emitConnectionListChanged();
    const latest = requireConnection(await snapshot(), current.slug);
    return {
      models: [...latest.models],
      source: result.source,
      fetchedAt: result.fetchedAt,
    };
  });
  deps.ipcMain.handle(
    'connections:test',
    async (_event, slug: unknown, options?: { model?: unknown }) => {
      const current = requireConnection(await snapshot(), slug);
      const model = options?.model;
      if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
        throw new Error('Invalid Connection test model');
      }
      const result = await deps.client.testConnection(current.connectionId, model);
      deps.emitConnectionListChanged();
      return projectHostConnectionTest(result);
    },
  );
  deps.ipcMain.handle('connections:profiles:query', async (_event, slug: unknown) => {
    const current = requireConnection(await snapshot(), slug);
    const result = await deps.client.queryCredentialProfileReadiness(current.connectionId);
    if (result.kind !== 'found') throw new Error('Connection no longer exists');
    return projectCredentialProfileReadiness(result);
  });
  deps.ipcMain.handle(
    'connections:profiles:usage',
    async (_event, slug: unknown, profileId: unknown): Promise<CredentialProfileUsageView> => {
      const current = requireConnection(await snapshot(), slug);
      if (typeof profileId !== 'string' || profileId.trim().length === 0) {
        throw new Error('Invalid Profile usage request');
      }
      const result = await deps.client.fetchOAuthAccountUsage(
        current.connectionId,
        profileId.trim(),
      );
      return result.kind === 'available'
        ? { kind: 'available', quota: result.quota }
        : { kind: 'unavailable', reason: result.reason };
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:create',
    async (_event, slug: unknown, raw: unknown) => {
      const catalog = await snapshot();
      const current = requireConnection(catalog, slug);
      const input = normalizeProfileCreateInput(raw);
      const created = await deps.client.createCredentialProfile({
        expected: { connectionId: current.connectionId, revision: current.revision },
        label: input.label,
        weight: input.weight,
      });
      requireCommitted(created, 'create Profile');
      deps.emitConnectionListChanged();
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:update',
    async (_event, slug: unknown, raw: unknown) => {
      const current = requireConnection(await snapshot(), slug);
      const input = normalizeProfileUpdateInput(raw);
      const updated = await deps.client.updateCredentialProfile({
        expected: {
          connectionId: current.connectionId,
          connectionRevision: current.revision,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        },
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
      });
      requireCommitted(updated, 'update Profile');
      deps.emitConnectionListChanged();
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:setEnabled',
    async (_event, slug: unknown, raw: unknown) => {
      const current = requireConnection(await snapshot(), slug);
      const input = normalizeProfileBasisInput(raw, 'Profile enable toggle');
      if (typeof input.enabled !== 'boolean') throw new Error('Invalid Profile enable toggle');
      const updated = await deps.client.setCredentialProfileEnabled({
        expected: {
          connectionId: current.connectionId,
          connectionRevision: current.revision,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        },
        enabled: input.enabled,
      });
      requireCommitted(updated, 'update Profile enable state');
      deps.emitConnectionListChanged();
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:remove',
    async (_event, slug: unknown, raw: unknown) => {
      const current = requireConnection(await snapshot(), slug);
      const input = normalizeProfileBasisInput(raw, 'Profile delete');
      const removed = await deps.client.removeCredentialProfile({
        expected: {
          connectionId: current.connectionId,
          connectionRevision: current.revision,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
        },
      });
      requireCommitted(removed, 'remove Profile');
      deps.emitConnectionListChanged();
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:setRoutingMode',
    async (_event, slug: unknown, raw: unknown) => {
      const catalog = await snapshot();
      const current = requireConnection(catalog, slug);
      const input = normalizeProfileRoutingModeInput(raw);
      const updated = await deps.client.setCredentialRoutingMode({
        expected: { connectionId: current.connectionId, revision: current.revision },
        mode: input.mode,
        ...(input.strategy ? { strategy: input.strategy } : {}),
        ...(input.orderedProfileIds ? { orderedProfileIds: input.orderedProfileIds } : {}),
      });
      if (updated.kind !== 'committed') {
        throw new Error(
          updated.kind === 'balanced_activation_rejected'
            ? updated.reason
            : `Unable to change Profile routing mode: ${updated.kind}`,
        );
      }
      deps.emitConnectionListChanged();
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:setCredential',
    async (_event, slug: unknown, raw: unknown) => {
      const current = requireConnection(await snapshot(), slug);
      const input = normalizeProfileCredentialInput(raw);
      const locator = profileCredentialLocator(current, input.profileId);
      const currentCredential = await deps.client.queryCredential(locator);
      const result = await deps.client.setCredential({
        locator,
        expected: currentCredential?.configured
          ? {
              credentialId: currentCredential.credentialId,
              revision: currentCredential.revision,
            }
          : null,
        secret: input.secret,
      });
      if (result.kind !== 'committed') {
        throw new Error(`Unable to save Profile credential: ${result.kind}`);
      }
      deps.emitConnectionListChanged();
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:test',
    async (_event, slug: unknown, raw: unknown) => {
      const current = requireConnection(await snapshot(), slug);
      const input = normalizeProfileTestInput(raw);
      const result = await deps.client.testConnectionProfile(
        current.connectionId,
        input.profileId,
        input.modelId,
      );
      deps.emitConnectionListChanged();
      return projectHostProfileTest(result);
    },
  );
  deps.ipcMain.handle(
    'connections:profiles:fetchModels',
    async (_event, slug: unknown, raw: unknown) => {
      const current = requireConnection(await snapshot(), slug);
      const input = normalizeProfileBasisInput(raw, 'Profile model fetch');
      const result = await deps.client.fetchConnectionProfileModels(
        current.connectionId,
        input.profileId,
      );
      if (result.kind !== 'committed') {
        throw new Error(`Unable to fetch Profile models: ${result.kind}`);
      }
      deps.emitConnectionListChanged();
      const latest = requireConnection(await snapshot(), current.slug);
      return {
        models: [...latest.models],
        source: result.source,
        fetchedAt: result.fetchedAt,
      };
    },
  );
}

export function projectHostProfileTest(
  result: ConnectionProfileTestRunResult,
): ConnectionTestResult {
  if (result.kind !== 'committed') {
    return { ok: false, errorMessage: `Profile test did not run: ${result.kind}` };
  }
  if (result.test.kind === 'verified') {
    return {
      ok: true,
      modelTested: result.test.modelId,
      latencyMs: result.test.latencyMs,
    };
  }
  return {
    ok: false,
    ...(result.test.modelId === null ? {} : { modelTested: result.test.modelId }),
    ...(result.test.latencyMs === null ? {} : { latencyMs: result.test.latencyMs }),
    ...(result.test.statusCode === null ? {} : { statusCode: result.test.statusCode }),
    errorClass: result.test.errorClass === 'invalid_response'
      ? 'unknown'
      : result.test.errorClass,
  };
}

export function projectHostConnectionTest(result: ConnectionTestRunResult): ConnectionTestResult {
  if (result.kind !== 'committed') {
    return { ok: false, errorMessage: `Connection test did not run: ${result.kind}` };
  }
  if (result.test.kind === 'verified') {
    return {
      ok: true,
      modelTested: result.test.modelId,
      latencyMs: result.test.latencyMs,
    };
  }
  return {
    ok: false,
    ...(result.test.modelId === null ? {} : { modelTested: result.test.modelId }),
    ...(result.test.latencyMs === null ? {} : { latencyMs: result.test.latencyMs }),
    ...(result.test.statusCode === null ? {} : { statusCode: result.test.statusCode }),
    errorClass: result.test.errorClass === 'invalid_response'
      ? 'unknown'
      : result.test.errorClass,
  };
}

export function projectHostConnections(catalog: ConnectionCatalogSnapshot): LlmConnection[] {
  return catalog.connections.map((connection) => {
    const defaultModel =
      catalog.defaultTarget?.connectionId === connection.connectionId
        ? catalog.defaultTarget.modelId
        : '';
    return {
      slug: connection.slug,
      name: connection.name,
      providerType: connection.providerType,
      ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
      enabled: connection.enabled,
      defaultModel,
      enabledModelIds: [...connection.enabledModelIds],
      models: [...connection.models],
      ...(connection.relayModelProfiles === undefined
        ? {}
        : { relayModelProfiles: connection.relayModelProfiles }),
      ...(connection.requestBodyOverlay === undefined
        ? {}
        : { requestBodyOverlay: connection.requestBodyOverlay }),
      ...(connection.modelSource === undefined ? {} : { modelSource: connection.modelSource }),
      ...(connection.modelsFetchedAt === undefined
        ? {}
        : { modelsFetchedAt: connection.modelsFetchedAt }),
      ...(connection.lastTest === undefined
        ? {}
        : {
            lastTestStatus: connection.lastTest.status,
            lastTestAt: connection.lastTest.checkedAt,
            ...(connection.lastTest.errorClass === undefined
              ? {}
              : { lastTestMessage: connection.lastTest.errorClass }),
          }),
      createdAt: 0,
      updatedAt: connection.revision,
    };
  });
}

async function updateCredential(
  client: HostConnectionsClient,
  connection: ConnectionCatalogEntry,
  secret: string,
): Promise<void> {
  const locator = connectionCredential(connection);
  const current = await client.queryCredential(locator);
  const result = secret
    ? await client.setCredential({
        locator,
        expected: current?.configured
          ? {
              credentialId: current.credentialId,
              revision: current.revision,
            }
          : null,
        secret,
      })
    : current?.configured
      ? await client.deleteCredential({
          expected: {
            credentialId: current.credentialId,
            locator,
            revision: current.revision,
          },
        })
      : undefined;
  if (result && result.kind !== 'committed') {
    throw new Error(`Unable to update Connection credential: ${result.kind}`);
  }
}

function connectionCredential(connection: ConnectionCatalogEntry): CredentialLocator {
  const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
  return {
    scope: 'connection',
    connectionId: connection.connectionId,
    kind: authKind === 'oauth_token' ? 'oauth_token' : 'api_key',
  };
}

function defaultConnection(catalog: ConnectionCatalogSnapshot): ConnectionCatalogEntry | undefined {
  return catalog.connections.find(
    ({ connectionId }) => connectionId === catalog.defaultTarget?.connectionId,
  );
}

function requireConnection(
  catalog: ConnectionCatalogSnapshot,
  value: unknown,
): ConnectionCatalogEntry {
  const slug = normalizeConnectionSlugForIpc(value, 'connection slug');
  const connection = catalog.connections.find((candidate) => candidate.slug === slug);
  if (!connection) throw new Error(`No such Connection: ${slug}`);
  return connection;
}

function requireProjectedConnection(
  catalog: ConnectionCatalogSnapshot,
  slug: string,
): LlmConnection {
  const connection = projectHostConnections(catalog).find((candidate) => candidate.slug === slug);
  if (!connection) throw new Error(`No such Connection: ${slug}`);
  return connection;
}

function defaultTargetForConnection(connection: ConnectionCatalogEntry) {
  const modelId = connection.enabledModelIds[0];
  if (!modelId) throw new Error(`Connection has no enabled model: ${connection.slug}`);
  return { connectionId: connection.connectionId, modelId };
}

function explicitDefaultTarget(catalog: ConnectionCatalogSnapshot, value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('slug' in value) ||
    !('model' in value) ||
    typeof value.slug !== 'string' ||
    typeof value.model !== 'string' ||
    value.model.length === 0
  ) {
    throw new Error('Default model input must include slug and model');
  }
  const connection = requireConnection(catalog, value.slug);
  if (!connection.enabledModelIds.includes(value.model)) {
    throw new Error(`Model is not enabled: ${value.model}`);
  }
  return { connectionId: connection.connectionId, modelId: value.model };
}

function normalizeCreateInput(value: unknown): CreateConnectionInput {
  return normalizeCreateConnectionInputForIpc(value);
}

function normalizeUpdateInput(
  current: ConnectionCatalogEntry,
  value: unknown,
): UpdateConnectionInput {
  const patch = normalizeConnectionPatchSecretsForIpc(value);
  if (patch.enabledModelIds !== undefined && !patch.enabledModelIds.every((id) => typeof id === 'string')) {
    throw new Error('Invalid enabled model list');
  }
  if (patch.baseUrl === undefined) return patch;
  const normalized = normalizeConnectionBaseUrlForIpc({
    slug: current.slug,
    name: current.name,
    providerType: current.providerType,
    baseUrl: patch.baseUrl,
  });
  return { ...patch, baseUrl: normalized.baseUrl };
}

function requireCommitted(
  result: { kind: string },
  operation: string,
): void {
  if (result.kind !== 'committed') throw new Error(`Unable to ${operation}: ${result.kind}`);
}

interface ProfileCreateIpcInput {
  readonly label: string;
  readonly weight: number;
}

interface ProfileUpdateIpcInput {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly label?: string;
  readonly weight?: number;
}

interface ProfileBasisIpcInput {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly enabled?: boolean;
}

interface ProfileRoutingModeIpcInput {
  readonly mode: 'legacy_primary' | 'balanced';
  readonly strategy?: 'smooth_weighted_round_robin' | 'priority_failover';
  readonly orderedProfileIds?: readonly string[];
}

interface ProfileCredentialIpcInput {
  readonly profileId: string;
  readonly secret: string;
}

interface ProfileTestIpcInput {
  readonly profileId: string;
  readonly modelId?: string;
}

function normalizeProfileCreateInput(value: unknown): ProfileCreateIpcInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('label' in value) ||
    !('weight' in value) ||
    typeof value.label !== 'string' ||
    value.label.trim().length === 0 ||
    typeof value.weight !== 'number' ||
    !Number.isInteger(value.weight) ||
    value.weight < 1 ||
    value.weight > 100
  ) {
    throw new Error('Profile create input must include a label and a 1-100 weight');
  }
  return { label: value.label.trim(), weight: value.weight };
}

function normalizeProfileUpdateInput(value: unknown): ProfileUpdateIpcInput {
  const base = normalizeProfileBasisInput(value, 'Profile update');
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Profile update');
  const label = 'label' in value ? value.label : undefined;
  const weight = 'weight' in value ? value.weight : undefined;
  if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0)) {
    throw new Error('Profile label must be a non-empty string');
  }
  if (
    weight !== undefined &&
    (typeof weight !== 'number' ||
      !Number.isInteger(weight) ||
      weight < 1 ||
      weight > 100)
  ) {
    throw new Error('Profile weight must be an integer from 1 to 100');
  }
  return {
    profileId: base.profileId,
    profileRevision: base.profileRevision,
    ...(label === undefined ? {} : { label: (label as string).trim() }),
    ...(weight === undefined ? {} : { weight: weight as number }),
  };
}

function normalizeProfileBasisInput(value: unknown, label: string): ProfileBasisIpcInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('profileId' in value) ||
    !('profileRevision' in value) ||
    typeof value.profileId !== 'string' ||
    value.profileId.length === 0 ||
    typeof value.profileRevision !== 'number' ||
    !Number.isSafeInteger(value.profileRevision) ||
    value.profileRevision < 1
  ) {
    throw new Error(`Invalid ${label} basis`);
  }
  const enabled = 'enabled' in value ? value.enabled : undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`Invalid ${label} enable flag`);
  }
  return {
    profileId: value.profileId,
    profileRevision: value.profileRevision,
    ...(enabled === undefined ? {} : { enabled: enabled as boolean }),
  };
}

function normalizeProfileRoutingModeInput(value: unknown): ProfileRoutingModeIpcInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('mode' in value) ||
    (value.mode !== 'legacy_primary' && value.mode !== 'balanced')
  ) {
    throw new Error('Profile routing mode must be legacy_primary or balanced');
  }
  const strategy = 'strategy' in value ? value.strategy : undefined;
  if (
    strategy !== undefined &&
    strategy !== 'smooth_weighted_round_robin' &&
    strategy !== 'priority_failover'
  ) {
    throw new Error('Profile routing strategy is invalid');
  }
  const orderedProfileIds = 'orderedProfileIds' in value ? value.orderedProfileIds : undefined;
  if (
    orderedProfileIds !== undefined &&
    (!Array.isArray(orderedProfileIds) ||
      orderedProfileIds.length === 0 ||
      orderedProfileIds.length > 32 ||
      orderedProfileIds.some((profileId) => typeof profileId !== 'string' || !profileId.trim()) ||
      new Set(orderedProfileIds).size !== orderedProfileIds.length)
  ) {
    throw new Error('Profile order must contain unique Profile ids');
  }
  return {
    mode: value.mode,
    ...(strategy === undefined ? {} : { strategy }),
    ...(orderedProfileIds === undefined
      ? {}
      : { orderedProfileIds: orderedProfileIds as string[] }),
  };
}

function normalizeProfileCredentialInput(value: unknown): ProfileCredentialIpcInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('profileId' in value) ||
    !('secret' in value) ||
    typeof value.profileId !== 'string' ||
    value.profileId.length === 0 ||
    typeof value.secret !== 'string'
  ) {
    throw new Error('Profile credential input must include a profileId and a secret');
  }
  return { profileId: value.profileId, secret: value.secret };
}

function normalizeProfileTestInput(value: unknown): ProfileTestIpcInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('profileId' in value) ||
    typeof value.profileId !== 'string' ||
    value.profileId.length === 0
  ) {
    throw new Error('Profile test input must include a profileId');
  }
  const modelId = 'modelId' in value ? value.modelId : undefined;
  if (modelId !== undefined && (typeof modelId !== 'string' || modelId.length === 0)) {
    throw new Error('Profile test model must be a non-empty string');
  }
  return {
    profileId: value.profileId,
    ...(modelId === undefined ? {} : { modelId: modelId as string }),
  };
}

function profileCredentialLocator(
  connection: ConnectionCatalogEntry,
  profileId: string,
): Extract<CredentialLocator, { scope: 'connection_profile' }> {
  if (profileId === connection.connectionId) {
    throw new Error('The primary Profile credential uses the Connection credential');
  }
  const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
  return {
    scope: 'connection_profile',
    connectionId: connection.connectionId,
    profileId,
    kind: authKind === 'oauth_token' ? 'oauth_token' : 'api_key',
  };
}
