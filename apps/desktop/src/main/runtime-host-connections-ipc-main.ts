import type { IpcMain } from 'electron';
import type {
  ConnectionTestResult,
  CreateConnectionInput,
  LlmConnection,
  UpdateConnectionInput,
} from '@maka/core';
import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
} from '@maka/core/llm-connections';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import type { ConnectionTestRunResult } from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  normalizeConnectionBaseUrlForIpc,
  normalizeConnectionPatchSecretsForIpc,
  normalizeConnectionSlugForIpc,
  normalizeCreateConnectionInputForIpc,
} from './connections-ipc-validation.js';

type HostConnectionsClient = Pick<
  DesktopRuntimeHostClient,
  | 'createConnection'
  | 'deleteCredential'
  | 'fetchConnectionModels'
  | 'loadConnectionCatalog'
  | 'queryCredential'
  | 'removeConnection'
  | 'setCredential'
  | 'setDefaultConnectionTarget'
  | 'testConnection'
  | 'updateConnection'
>;

export interface RuntimeHostConnectionsIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: HostConnectionsClient;
  readonly emitConnectionListChanged: () => void;
}

export function registerRuntimeHostConnectionsIpc(
  deps: RuntimeHostConnectionsIpcDeps,
): void {
  const snapshot = () => deps.client.loadConnectionCatalog();
  const projected = async () => projectHostConnections(await snapshot());

  deps.ipcMain.handle('connections:list', projected);
  deps.ipcMain.handle('connections:getDefault', async () => {
    const catalog = await snapshot();
    return defaultConnection(catalog)?.slug ?? null;
  });
  deps.ipcMain.handle('connections:hasSecret', async (_event, slug: unknown) => {
    const catalog = await snapshot();
    const connection = requireConnection(catalog, slug);
    if (!providerAuthRequiresSecret(connection.providerType)) return true;
    return (
      (await deps.client.queryCredential(connectionCredential(connection)))
        ?.configured === true
    );
  });
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
    const created = await deps.client.createConnection(catalog.revision, {
      slug: input.slug,
      name: input.name,
      providerType: input.providerType,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      enabled: true,
      enabledModelIds: input.defaultModel ? [input.defaultModel] : [],
    });
    if (created.kind !== 'committed') {
      throw new Error(`Unable to create Connection: ${created.kind}`);
    }
    if (input.apiKey) {
      const entry = requireConnection(await snapshot(), input.slug);
      const credential = await deps.client.setCredential({
        locator: connectionCredential(entry),
        expected: null,
        secret: input.apiKey,
      });
      if (credential.kind !== 'committed') {
        await deps.client.removeConnection(created.connection).catch(() => undefined);
        throw new Error(`Unable to save Connection credential: ${credential.kind}`);
      }
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
    const catalog = await snapshot();
    const current = requireConnection(catalog, slug);
    requireCommitted(
      await deps.client.removeConnection({
        connectionId: current.connectionId,
        revision: current.revision,
      }),
      'delete Connection',
    );
    deps.emitConnectionListChanged();
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
        : connection.enabledModelIds[0] ?? '';
    return {
      slug: connection.slug,
      name: connection.name,
      providerType: connection.providerType,
      ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
      enabled: connection.enabled,
      defaultModel,
      enabledModelIds: [...connection.enabledModelIds],
      models: [...connection.models],
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
