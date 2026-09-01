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

import type {
  ConnectionTestResult,
  CreateConnectionInput,
  IdentifiedLlmConnection,
  LlmConnection,
  SavedRequestHeaders,
  UpdateConnectionInput,
} from '@maka/core/llm-connections';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import {
  connectionEnabledModelIds,
  defaultEnabledModelIdsWhenOmitted,
  PROVIDER_REGISTRY,
  providerAuthRequiresSecret,
} from '@maka/core/llm-connections';
import { normalizeRelayModelProfiles } from '@maka/core/model-thinking';
import type { CredentialLocator } from '@maka/core/runtime-policy';
import type {
  RuntimeHostConnectionCatalogEntry as ConnectionCatalogEntry,
  RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot,
} from '@maka/runtime-host/client';
import { normalizeRequestHeaderUpdates } from '@maka/core/runtime-policy';
import {
  CONNECTION_EFFECT_OPERATION_SPECS,
  type ConnectionTestRunResult,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
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
import type {
  DesktopConnectionIdentity,
  DesktopConnectionSnapshot,
} from '../shared/desktop-connection-snapshot.js';
import type { DesktopConnectionOnboardingSaveOutcome } from '../preload/bridge-contract.js';

type HostConnectionsClient = Pick<
  DesktopRuntimeHostClient,
  | 'createConnection'
  | 'deleteCredential'
  | 'fetchConnectionModels'
  | 'getConnectionRequestHeaders'
  | 'loadConnectionCatalog'
  | 'queryCredential'
  | 'removeConnection'
  | 'replaceConnectionRequestHeaders'
  | 'setCredential'
  | 'setDefaultConnectionTarget'
  | 'testConnection'
  | 'updateConnection'
  | 'verifyConnectionOnboarding'
  | 'saveConnectionOnboarding'
>;

export interface RuntimeHostConnectionsIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: HostConnectionsClient;
  readonly emitConnectionListChanged: () => void;
}

export function registerRuntimeHostConnectionsIpc(
  deps: RuntimeHostConnectionsIpcDeps,
): void {
  const snapshot = () => deps.client.loadConnectionCatalog();

  handleReconnectableRead(deps.ipcMain, 'connections:getSnapshot', async () => {
    const catalog = await snapshot();
    const connections = projectHostConnections(catalog);
    return {
      connections,
      defaultConnection: defaultConnection(catalog)?.slug ?? null,
      chatModelChoices: buildChatModelChoices(connections),
    } satisfies DesktopConnectionSnapshot;
  });
  handleReconnectableRead(deps.ipcMain, 'connections:hasSecret', async (_event, identity: unknown) => {
    const catalog = await snapshot();
    const connection = requireConnectionIdentity(catalog, identity);
    if (!providerAuthRequiresSecret(connection.providerType)) return true;
    return (
      (await deps.client.queryCredential(connectionCredential(connection)))
        ?.configured === true
    );
  });
  handleReconnectableRead(
    deps.ipcMain,
    'connections:getRequestHeaders',
    async (_event, identity: unknown) => {
      const connection = requireConnectionIdentity(await snapshot(), identity);
      const result = await deps.client.getConnectionRequestHeaders(connection.connectionId);
      if (result.kind !== 'found') throw new Error('Connection no longer exists');
      return { names: result.names } satisfies SavedRequestHeaders;
    },
  );
  deps.ipcMain.handle(
    'connections:setRequestHeaders',
    async (_event, identity: unknown, rawUpdates: unknown) => {
      const connection = requireConnectionIdentity(await snapshot(), identity);
      const result = await deps.client.replaceConnectionRequestHeaders(
        connection.connectionId,
        normalizeRequestHeaderUpdates(rawUpdates),
      );
      if (result.kind === 'connection_not_found') throw new Error('Connection no longer exists');
      if (result.kind === 'committed') deps.emitConnectionListChanged();
      return { names: result.names } satisfies SavedRequestHeaders;
    },
  );
  deps.ipcMain.handle('connections:setDefault', async (_event, identity: unknown) => {
    const catalog = await snapshot();
    const target = identity === null
      ? null
      : defaultTargetForConnection(requireConnectionIdentity(catalog, identity));
    requireCommitted(
      await deps.client.setDefaultConnectionTarget(catalog.revision, target),
      'set default Connection',
    );
    deps.emitConnectionListChanged();
  });
  deps.ipcMain.handle('connections:setDefaultBySlug', async (_event, slug: unknown) => {
    const catalog = await snapshot();
    requireCommitted(
      await deps.client.setDefaultConnectionTarget(
        catalog.revision,
        defaultTargetForConnection(requireConnection(catalog, slug)),
      ),
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
  deps.ipcMain.handle('connections:onboardingVerify', async (_event, raw: unknown) => {
    const input = CONNECTION_EFFECT_OPERATION_SPECS[
      'connection.onboarding.verify'
    ].decodeInput(raw);
    return deps.client.verifyConnectionOnboarding(input);
  });
  deps.ipcMain.handle('connections:onboardingSave', async (_event, raw: unknown) => {
    const input = CONNECTION_EFFECT_OPERATION_SPECS[
      'connection.onboarding.save'
    ].decodeInput(raw);
    try {
      const result = await deps.client.saveConnectionOnboarding(input);
      if (result.kind === 'saved') deps.emitConnectionListChanged();
      return { kind: 'result', result } satisfies DesktopConnectionOnboardingSaveOutcome;
    } catch (error) {
      if (error instanceof RuntimeHostOperationError) {
        return {
          kind: error.code === 'commit_outcome_unknown' ? 'outcome_unknown' : 'not_saved',
        } satisfies DesktopConnectionOnboardingSaveOutcome;
      }
      if (error instanceof RuntimeHostRequestInterruptedError) {
        return {
          kind: error.dispatch === 'not_dispatched' ? 'not_saved' : 'outcome_unknown',
        } satisfies DesktopConnectionOnboardingSaveOutcome;
      }
      // A protocol/decode failure can arrive only after the command response
      // has started coming back. Without affirmative evidence that the Host
      // did not commit, allowing another create risks duplicating the account.
      return { kind: 'outcome_unknown' } satisfies DesktopConnectionOnboardingSaveOutcome;
    }
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
  deps.ipcMain.handle('connections:update', async (_event, rawIdentity: unknown, rawPatch: unknown) => {
    const catalog = await snapshot();
    const current = requireConnectionIdentity(catalog, rawIdentity);
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
      const entry = requireConnectionIdentity(latest, connectionIdentity(current));
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
    return requireProjectedConnectionIdentity(await snapshot(), connectionIdentity(current));
  });
  deps.ipcMain.handle('connections:delete', async (_event, rawIdentity: unknown) => {
    const identity = normalizeConnectionIdentity(rawIdentity);
    // OAuth/model-fetch can bump the connection revision under the UI. Retry
    // on connection_stale with a fresh snapshot so delete does not fail with a
    // opaque "service unavailable" after the user already confirmed.
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const catalog = await snapshot();
      let current: ReturnType<typeof requireConnection>;
      try {
        current = requireConnectionIdentity(catalog, identity);
      } catch (error) {
        // The exact entity is already gone. A new entity may reuse its slug;
        // deleting that replacement would violate the detail route's binding.
        if (error instanceof Error && error.message.startsWith('No such Connection identity:')) {
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
  deps.ipcMain.handle('connections:fetchModels', async (_event, identity: unknown) => {
    const current = requireConnectionIdentity(await snapshot(), identity);
    const result = await deps.client.fetchConnectionModels(current.connectionId);
    if (result.kind !== 'committed') {
      throw new Error(`Unable to fetch Connection models: ${result.kind}`);
    }
    deps.emitConnectionListChanged();
    const latest = requireConnectionIdentity(await snapshot(), connectionIdentity(current));
    return { models: [...latest.models], source: result.source };
  });
  deps.ipcMain.handle(
    'connections:test',
    async (_event, identity: unknown, options?: { model?: unknown }) => {
      const current = requireConnectionIdentity(await snapshot(), identity);
      const model = options?.model;
      if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
        throw new Error('Invalid Connection test model');
      }
      const result = await deps.client.testConnection(current.connectionId, model);
      deps.emitConnectionListChanged();
      return projectHostConnectionTest(result);
    },
  );
  deps.ipcMain.handle(
    'connections:testBySlug',
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

export function projectHostConnections(
  catalog: ConnectionCatalogSnapshot,
): ProjectedLlmConnection[] {
  return catalog.connections.map((connection) => {
    const defaultModel =
      catalog.defaultTarget?.connectionId === connection.connectionId
        ? catalog.defaultTarget.modelId
        : '';
    return {
      connectionId: connection.connectionId,
      slug: connection.slug,
      name: connection.name,
      providerType: connection.providerType,
      ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
      enabled: connection.enabled,
      defaultModel,
      enabledModelIds: [...connection.enabledModelIds],
      models: [...connection.models],
      catalogEntries: connection.catalogEntries,
      ...(connection.relayModelProfiles === undefined
        ? {}
        : { relayModelProfiles: connection.relayModelProfiles }),
      ...(connection.requestBodyOverlay === undefined
        ? {}
        : { requestBodyOverlay: connection.requestBodyOverlay }),
      ...(connection.modelSource === undefined ? {} : { modelSource: connection.modelSource }),
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
  const authKind = PROVIDER_REGISTRY[connection.providerType].authKind;
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

function normalizeConnectionIdentity(value: unknown): DesktopConnectionIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Connection identity');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'connectionId' || keys[1] !== 'slug') {
    throw new Error('Invalid Connection identity');
  }
  if (typeof record.connectionId !== 'string' || record.connectionId.length === 0) {
    throw new Error('Connection identity id is required');
  }
  return {
    connectionId: record.connectionId,
    slug: normalizeConnectionSlugForIpc(record.slug, 'connection identity slug'),
  };
}

function requireConnectionIdentity(
  catalog: ConnectionCatalogSnapshot,
  value: unknown,
): ConnectionCatalogEntry {
  const identity = normalizeConnectionIdentity(value);
  const connection = catalog.connections.find(
    (candidate) => candidate.connectionId === identity.connectionId,
  );
  if (!connection) throw new Error(`No such Connection identity: ${identity.connectionId}`);
  if (connection.slug !== identity.slug) {
    throw new Error('Connection identity no longer matches its slug');
  }
  return connection;
}

function connectionIdentity(connection: ConnectionCatalogEntry): DesktopConnectionIdentity {
  return { connectionId: connection.connectionId, slug: connection.slug };
}

function requireProjectedConnection(
  catalog: ConnectionCatalogSnapshot,
  slug: string,
): LlmConnection {
  const connection = projectHostConnections(catalog).find((candidate) => candidate.slug === slug);
  if (!connection) throw new Error(`No such Connection: ${slug}`);
  return connection;
}

function requireProjectedConnectionIdentity(
  catalog: ConnectionCatalogSnapshot,
  identity: DesktopConnectionIdentity,
): ProjectedLlmConnection {
  const connection = requireConnectionIdentity(catalog, identity);
  const projected = projectHostConnections(catalog).find(
    (candidate) => candidate.connectionId === connection.connectionId,
  );
  if (!projected) throw new Error(`No such Connection identity: ${identity.connectionId}`);
  return projected;
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
