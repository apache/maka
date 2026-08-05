import type { IpcMain } from 'electron';
import {
  buildConnectionModelCatalogEntries,
  generalizedErrorMessageChinese,
} from '@maka/core';
import type {
  CreateConnectionInput,
  UpdateConnectionInput,
} from '@maka/core';
import { PROVIDER_DEFAULTS, providerAuthRequiresSecret } from '@maka/core/llm-connections';
import type { LlmConnection } from '@maka/core/llm-connections';
import { testConnection } from '@maka/runtime';
import { createConnectionStore } from '@maka/storage';
import {
  ConnectionModelDiscoveryPreconditionError,
  discoverConnectionModels,
  type ConnectionModelDiscoveryDeps,
} from './connection-model-discovery.js';
import { createFileCredentialStore } from './credential-store.js';
import { createConnectionWithCredential } from './create-connection-with-credential.js';
import { deleteConnectionWithCredential } from './delete-connection-with-credential.js';
import { connectionTestStatusPatch } from './connection-test-status.js';
import {
  normalizeConnectionBaseUrlValueForIpc,
  normalizeConnectionPatchSecretsForIpc,
  normalizeConnectionSlugForIpc,
  normalizeCreateConnectionInputForIpc,
} from './connections-ipc-validation.js';

type ConnectionStore = ReturnType<typeof createConnectionStore>;
type CredentialStore = ReturnType<typeof createFileCredentialStore>;

interface ConnectionInputNormalizerDeps {
  connectionStore: ConnectionStore;
}

interface ConnectionsIpcDeps extends ConnectionInputNormalizerDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  credentialStore: CredentialStore;
  syncOAuthModelConnections: () => Promise<void>;
  resolveConnectionSecret: (slug: string) => Promise<string | null>;
  hasConnectionSecret: (connection: LlmConnection) => Promise<boolean>;
  disconnectManagedOAuthConnection: (connection: LlmConnection) => Promise<void>;
  emitConnectionListChanged: () => void;
  /**
   * Override for remote model discovery. Only E2E supplies this, to keep the
   * add-provider flow off the public internet (see main.ts).
   */
  fetchModels?: ConnectionModelDiscoveryDeps['fetchModels'];
}

async function normalizeUpdateConnectionInput(
  deps: ConnectionInputNormalizerDeps,
  slug: string,
  patch: UpdateConnectionInput,
): Promise<UpdateConnectionInput> {
  const normalizedPatch = normalizeConnectionPatchSecretsForIpc(patch);
  const { connectionStore } = deps;
  const existing = await connectionStore.get(slug);
  const providerType = existing?.providerType;
  const defaults = providerType ? PROVIDER_DEFAULTS[providerType] : undefined;
  if (defaults?.authKind === 'oauth_token') {
    if (!Object.prototype.hasOwnProperty.call(normalizedPatch, 'baseUrl') || normalizedPatch.baseUrl === undefined) {
      return normalizedPatch;
    }
    return { ...normalizedPatch, baseUrl: existing?.baseUrl ?? defaults.baseUrl };
  }
  if (normalizedPatch.baseUrl === undefined) return normalizedPatch;
  if (!providerType) throw new Error(`No such connection: ${slug}`);
  return {
    ...normalizedPatch,
    baseUrl: normalizeConnectionBaseUrlValueForIpc(providerType, normalizedPatch.baseUrl),
  };
}

export function registerConnectionsIpc(deps: ConnectionsIpcDeps): void {
  const {
    ipcMain,
    connectionStore,
    credentialStore,
    syncOAuthModelConnections,
    resolveConnectionSecret,
    hasConnectionSecret,
    disconnectManagedOAuthConnection,
    emitConnectionListChanged,
    fetchModels,
  } = deps;

  ipcMain.handle('connections:list', async () => {
    await syncOAuthModelConnections();
    return connectionStore.list();
  });
  ipcMain.handle('connections:getDefault', () => connectionStore.getDefault());
  ipcMain.handle('connections:setDefault', async (_event, slug: string | null) => {
    const normalizedSlug = slug === null ? null : normalizeConnectionSlugForIpc(slug, 'connection slug');
    if (normalizedSlug && !(await connectionStore.get(normalizedSlug))) {
      throw new Error(`No such connection: ${normalizedSlug}`);
    }
    await connectionStore.setDefault(normalizedSlug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:setDefaultModel', async (_event, input: { slug: string; model: string } | null) => {
    if (input === null) {
      await connectionStore.setDefault(null);
      emitConnectionListChanged();
      return;
    }
    if (!input || typeof input !== 'object' || typeof input.slug !== 'string' || typeof input.model !== 'string') {
      throw new Error('Default model input must include slug and model');
    }
    const slug = normalizeConnectionSlugForIpc(input.slug, 'connection slug');
    const model = input.model.trim();
    if (!model) throw new Error('Default model must not be empty');
    const connection = await connectionStore.get(slug);
    if (!connection) throw new Error(`No such connection: ${slug}`);
    if (!connection.enabled) throw new Error(`Connection is disabled: ${slug}`);
    const selectable = buildConnectionModelCatalogEntries({ connection })
      .some((entry) => entry.id === model && entry.canUseAsChatDefault);
    if (!selectable) {
      throw new Error(`Model is not available for chat default: ${model}`);
    }
    if (connection.defaultModel !== model) {
      await connectionStore.update(slug, { defaultModel: model });
    }
    await connectionStore.setDefault(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:create', async (_event, input: CreateConnectionInput) => {
    // baseUrl is a credentials-exfiltration boundary. Normalize before any
    // store or credential write; OAuth-token providers must keep their
    // canonical provider endpoint.
    const normalizedInput = normalizeCreateConnectionInputForIpc(input);
    const connection = await createConnectionWithCredential({ connectionStore, credentialStore }, normalizedInput);
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:update', async (_event, slug: string, patch: UpdateConnectionInput) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const normalizedPatch = await normalizeUpdateConnectionInput(deps, slug, patch);
    const connection = await connectionStore.update(slug, normalizedPatch);
    if (normalizedPatch.apiKey !== undefined) {
      if (normalizedPatch.apiKey) await credentialStore.setSecret(slug, 'api_key', normalizedPatch.apiKey);
      else await credentialStore.deleteSecret(slug, 'api_key');
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:delete', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    await deleteConnectionWithCredential(
      { connectionStore, credentialStore, disconnectManagedOAuthConnection },
      slug,
    );
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:test', async (_event, slug: string, opts?: { model?: string }) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    const connection = await connectionStore.get(slug);
    if (!connection) return { ok: false, errorMessage: `找不到模型连接：${slug}` };
    const apiKey = await resolveConnectionSecret(slug);
    if (providerAuthRequiresSecret(connection.providerType) && !apiKey) {
      return {
        ok: false,
        errorMessage: PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token'
          ? '这个 OAuth 模型连接还没有登录'
          : '这个模型连接还没有保存 API key',
        errorClass: 'auth',
      };
    }
    const result = await testConnection(connection, apiKey ?? '', opts?.model);
    await connectionStore.update(slug, connectionTestStatusPatch(result));
    emitConnectionListChanged();
    return result;
  });
  ipcMain.handle('connections:fetchModels', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    try {
      const result = await discoverConnectionModels({
        connectionStore,
        resolveConnectionSecret,
        ...(fetchModels ? { fetchModels } : {}),
      }, slug);
      emitConnectionListChanged();
      return result;
    } catch (error) {
      if (error instanceof ConnectionModelDiscoveryPreconditionError) throw error;
      throw new Error(generalizedErrorMessageChinese(error, '拉取模型列表失败'));
    }
  });
  ipcMain.handle('connections:hasSecret', async (_event, slug: string) => {
    slug = normalizeConnectionSlugForIpc(slug, 'connection slug');
    // Read-only status probe (session health notice): must use the
    // read-only hasConnectionSecret, never resolveConnectionSecret —
    // the latter refreshes near-expiry OAuth tokens over the network,
    // which a read-only status read must not do just by being observed.
    // Send/test/fetch-models stay on resolveConnectionSecret and keep
    // the refresh; the send gate remains the authoritative check.
    const connection = await connectionStore.get(slug);
    if (!connection) return false;
    return hasConnectionSecret(connection);
  });
}
